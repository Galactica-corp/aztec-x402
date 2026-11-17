/**
 * The merchant's background duties for `ref` and `split` payments, run one at
 * a time over the merchant's wallet:
 *
 * - On start, take in again every stored ref proof that was never taken in
 *   (a crash between storing it and `receivePayment`). Possible only within
 *   26 h of the buyer's transaction; `receivePayment` is idempotent.
 * - Consolidate: merge the private notes into one the merchant sends itself
 *   on chain, so the funds no longer depend on stored offchain messages. It
 *   runs at start and then every 6 h (configurable), each time only if a
 *   payment was taken in since the last consolidation (the store keeps when
 *   that was, so restarts neither skip nor repeat it). It first takes in
 *   every ref proof since then, so the notes another instance took in, or a
 *   wiped wallet lost, are merged too. A failed run is retried within minutes.
 * - Claim every served split deposit on Aztec once its message is
 *   consumable, retrying with backoff (a busy sponsor, a slow message), and
 *   rebuilding the claim from the buyer's proof if an L1 reorg moved the
 *   deposit. State lives in the store, so a restart resumes where it stopped.
 *
 * Several server instances may share a store: each runs `MerchantJobs`, and a
 * lease in the store lets one of them do the work; another takes over when it
 * stops or its lease runs out.
 */
import { randomUUID } from "node:crypto";
import {
  OFFCHAIN_MESSAGE_TTL_MS,
  RefAztecPayloadSchema,
  type ModeVerification,
  type PaymentStateStore,
  type RefPaymentProof,
  type StoredProof,
  type StoredSplitClaim,
} from "@galactica-net/x402-core";
import type { SplitClaimOutcome } from "./split-merchant.js";

/** The split side the jobs need; {@link SplitMerchant} is the real one. */
export interface SplitClaimer {
  claim(claimJson: string): Promise<SplitClaimOutcome>;
  /** The claim rebuilt from L1 as it is now (unchanged while L1 cannot confirm it yet), or undefined when the deposit is refused for good. */
  rebuild(claimJson: string): Promise<string | undefined>;
}

export interface MerchantJobsOptions {
  store: PaymentStateStore;
  /** Takes a stored ref proof into the merchant's wallet (the token adapter's `receivePayment`). */
  receive(asset: string, proof: RefPaymentProof, expected: { paymentRef: string; price: bigint }): Promise<ModeVerification>;
  /** Merges the merchant's notes, per token it sells in. */
  consolidate?: () => Promise<void>;
  split?: SplitClaimer;
  /** How often to check for something to consolidate (default 6 h): well inside the 26 h a stored message stays re-ingestible. */
  consolidateEveryMs?: number;
  /** How often pending split claims are looked at (default 30 s). */
  claimPollMs?: number;
  /** This instance's name in the lease (default: random). */
  instanceId?: string;
  /** How long the lease lasts without renewal (default 60 s); it is renewed every third of that. */
  leaseMs?: number;
  /** How often the leader logs the warnings of {@link MerchantJobs.status} (default 1 h). */
  statusEveryMs?: number;
  log?: (message: string) => void;
  now?: () => number;
}

/** What the background jobs know, from the store: what a health check shows. */
export interface MerchantStatus {
  /** This instance holds the lease and runs the jobs. */
  leader: boolean;
  /** When the last consolidation that succeeded started. */
  consolidatedAt?: number;
  /** Payments taken in since then: they exist only offchain until the next consolidation. */
  unconsolidated: { count: number; oldestAt?: number };
  /** Stored ref payments within the message lifetime that are not in the wallet yet. */
  proofsNotTakenIn: number;
  splitClaims: { pending: number; failed: number; consumedUnknown: number };
  /** Anything that needs a person; empty when all is well. */
  warnings: string[];
}

const LEASE = "merchant-jobs";
const MIN_BACKOFF_MS = 15_000;
const MAX_BACKOFF_MS = 10 * 60_000;
/** The wait after the `attempts`-th failure in a row: 30 s, doubling, at most 10 min. */
const backoff = (attempts: number) => Math.min(MIN_BACKOFF_MS * 2 ** Math.min(attempts, 10), MAX_BACKOFF_MS);
/** After this many attempts finding the message not consumable, check whether an L1 reorg moved the deposit. */
const REBUILD_EVERY = 10;
const HOUR = 3600_000;
/** An unconsolidated payment older than this is worth a warning, and past the second an error: 26 h is the end. */
export const UNCONSOLIDATED_WARN_MS = 12 * HOUR;
export const UNCONSOLIDATED_ERROR_MS = 20 * HOUR;
/** A stored proof not taken in this long after it arrived needs a look (not mined, or refused). */
const NOT_TAKEN_IN_WARN_MS = HOUR;
/**
 * A split claim still pending this long after its deposit was served needs a
 * look: a claim lands minutes after the deposit, and a switch-off takes effect
 * no sooner than this, after which the buyer can take the deposit back.
 */
export const UNCLAIMED_WARN_MS = HOUR;

export class MerchantJobs {
  private queue: Promise<unknown> = Promise.resolve();
  /** Timers of the jobs this instance runs while it leads. */
  private leaderTimers: ReturnType<typeof setInterval>[] = [];
  private consolidationTimer?: ReturnType<typeof setTimeout>;
  private leaseTimer?: ReturnType<typeof setInterval>;
  private statusTimer?: ReturnType<typeof setInterval>;
  private consolidationFailures = 0;
  private stopped = true;
  private leader = false;
  readonly instanceId: string;
  private readonly leaseMs: number;
  private readonly log: (message: string) => void;
  private readonly now: () => number;

  constructor(private readonly opts: MerchantJobsOptions) {
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.instanceId = opts.instanceId ?? randomUUID();
    this.leaseMs = opts.leaseMs ?? 60_000;
  }

  /** Runs `task` after every task queued before it: the merchant's wallet is used by one job at a time. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Whether this instance holds the lease and runs the jobs. */
  get isLeader(): boolean {
    return this.leader;
  }

  /**
   * Takes the lease if it is free and, as leader, replays stored proofs (this
   * resolves once that is done), then consolidates and claims on their
   * schedules. Without the lease it keeps asking for it and takes over when
   * the leader stops or its lease runs out.
   */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.tryLead();
    this.leaseTimer = setInterval(() => void this.tryLead().catch((e) => this.log(`Lease renewal failed: ${String(e)}`)), this.leaseMs / 3);
    this.statusTimer = setInterval(() => void this.logWarnings().catch(() => undefined), this.opts.statusEveryMs ?? HOUR);
  }

  /** Stops scheduling and gives the lease up; resolves once the running job is done. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.leaseTimer);
    clearInterval(this.statusTimer);
    this.stopLeading();
    await this.queue;
    if (this.leader) {
      this.leader = false;
      await this.opts.store.releaseLease(LEASE, this.instanceId).catch(() => undefined);
    }
  }

  private async tryLead(): Promise<void> {
    if (this.stopped) return;
    const held = await this.opts.store.acquireLease(LEASE, this.instanceId, this.leaseMs, this.now());
    if (this.stopped) return;
    if (held && !this.leader) {
      this.leader = true;
      this.log("This instance runs the merchant's background jobs.");
      await this.lead();
    } else if (!held && this.leader) {
      this.leader = false;
      this.stopLeading();
      this.log("Another instance took over the merchant's background jobs.");
    }
  }

  private async lead(): Promise<void> {
    await this.replayProofs();
    if (!this.leader || this.stopped) return;
    if (this.opts.consolidate) void this.consolidationTick();
    if (this.opts.split) {
      this.leaderTimers.push(setInterval(() => void this.claimDue().catch(() => undefined), this.opts.claimPollMs ?? 30_000));
      void this.claimDue().catch(() => undefined);
    }
  }

  private stopLeading(): void {
    this.leaderTimers.splice(0).forEach(clearInterval);
    clearTimeout(this.consolidationTimer);
    this.consolidationTimer = undefined;
  }

  /** Takes in every ref proof stored within the message lifetime and never taken in. */
  replayProofs(): Promise<{ taken: number; pending: number }> {
    return this.run(async () => {
      const { taken, pending } = await this.takeIn(await this.opts.store.proofsNotTakenIn(this.now() - OFFCHAIN_MESSAGE_TTL_MS));
      if (taken + pending > 0) this.log(`Replayed stored payment proofs: ${taken} taken in, ${pending} not.`);
      return { taken, pending };
    });
  }

  /**
   * Takes in again every ref proof since the last consolidation (within the
   * message lifetime), taken in before or not: after the wallet's store was
   * lost, or for payments another instance took into its own wallet.
   */
  takeInSinceConsolidation(): Promise<{ taken: number; pending: number }> {
    return this.run(() => this.takeInSinceConsolidationNow());
  }

  private async takeInSinceConsolidationNow(): Promise<{ taken: number; pending: number }> {
    const since = Math.max((await this.opts.store.consolidatedAt()) ?? 0, this.now() - OFFCHAIN_MESSAGE_TTL_MS);
    return this.takeIn(await this.opts.store.refProofs(since));
  }

  /** Takes each proof into the wallet; one valid proof per reference is enough. Not queued: callers hold the queue. */
  private async takeIn(proofs: StoredProof[]): Promise<{ taken: number; pending: number }> {
    const done = new Set<string>();
    const failed = new Set<string>();
    for (const stored of proofs) {
      if (done.has(stored.paymentRef)) continue;
      const parsed = RefAztecPayloadSchema.safeParse(JSON.parse(stored.payload));
      if (!parsed.success) continue;
      const { mode: _mode, ...proof } = parsed.data;
      try {
        const result = await this.opts.receive(stored.asset, proof, { paymentRef: stored.paymentRef, price: BigInt(stored.price) });
        if (result.isValid) {
          if (!stored.takenIn) await this.opts.store.markTakenIn(stored.paymentRef);
          done.add(stored.paymentRef);
        } else {
          failed.add(stored.paymentRef);
          if (!result.retryable) this.log(`Stored proof for ${stored.paymentRef} does not pay: ${result.error ?? result.reason}`);
        }
      } catch (error) {
        failed.add(stored.paymentRef);
        this.log(`Taking in the stored proof for ${stored.paymentRef} failed: ${String(error)}`);
      }
    }
    const pending = [...failed].filter((ref) => !done.has(ref)).length;
    return { taken: done.size, pending };
  }

  /** Consolidates if a payment was taken in since the last consolidation (or none is recorded); true when it ran. */
  consolidateIfDue(): Promise<boolean> {
    return this.consolidate(false);
  }

  /** Consolidates now, whether or not anything is new. */
  async consolidateNow(): Promise<void> {
    await this.consolidate(true);
  }

  private consolidate(force: boolean): Promise<boolean> {
    const consolidate = this.opts.consolidate;
    if (!consolidate) return Promise.resolve(false);
    return this.run(async () => {
      const { store } = this.opts;
      if (!force) {
        const last = await store.consolidatedAt();
        if (last !== undefined && (await store.takenInSince(last)).count === 0) return false;
      }
      const startedAt = this.now();
      const caught = await this.takeInSinceConsolidationNow();
      if (caught.pending > 0) this.log(`${caught.pending} stored payment(s) could not be taken in before consolidating; retried next time.`);
      try {
        await consolidate();
      } catch (error) {
        this.log(`Consolidation failed: ${String(error)}`);
        throw error;
      }
      await store.markConsolidated(startedAt);
      return true;
    });
  }

  /** One scheduled consolidation, then the next: the full interval after success, a backoff after a failure. */
  private async consolidationTick(): Promise<void> {
    if (!this.leader || this.stopped) return;
    let delay = this.opts.consolidateEveryMs ?? 6 * HOUR;
    try {
      await this.consolidateIfDue();
      this.consolidationFailures = 0;
    } catch {
      this.consolidationFailures++;
      delay = Math.min(delay, backoff(this.consolidationFailures));
      this.log(`Retrying the consolidation in ${Math.round(delay / 1000)} s.`);
    }
    if (this.leader && !this.stopped) this.consolidationTimer = setTimeout(() => void this.consolidationTick(), delay);
  }

  /** The jobs' state, from store reads only (cheap enough for a health check). */
  async status(): Promise<MerchantStatus> {
    const { store } = this.opts;
    const now = this.now();
    const consolidatedAt = await store.consolidatedAt();
    const unconsolidated = await store.takenInSince(consolidatedAt ?? 0);
    const notTakenIn = await store.proofsNotTakenIn(now - OFFCHAIN_MESSAGE_TTL_MS);
    const claims = await store.splitClaims();
    const count = (status: StoredSplitClaim["status"]) => claims.filter((c) => c.status === status).length;
    const splitClaims = { pending: count("pending"), failed: count("failed"), consumedUnknown: count("consumed-unknown") };

    const warnings: string[] = [];
    const age = unconsolidated.oldestAt === undefined ? 0 : now - unconsolidated.oldestAt;
    const hours = (ms: number) => `${Math.floor(ms / HOUR)} h`;
    if (age >= UNCONSOLIDATED_ERROR_MS) {
      warnings.push(`A payment has waited ${hours(age)} for consolidation; after 26 h it can no longer be restored if the wallet's store is lost.`);
    } else if (age >= UNCONSOLIDATED_WARN_MS) {
      warnings.push(`A payment has waited ${hours(age)} for consolidation (normally at most 6 h): is consolidation failing?`);
    }
    const stale = new Set(notTakenIn.filter((p) => now - p.receivedAt >= NOT_TAKEN_IN_WARN_MS).map((p) => p.paymentRef));
    if (stale.size > 0) warnings.push(`${stale.size} stored payment(s) have not been taken into the wallet for over an hour.`);
    const overdue = await this.overdueClaims(claims.filter((c) => c.status === "pending"), now);
    if (overdue.length > 0) {
      const lastError = overdue.map((c) => c.lastError).find((e) => e !== undefined);
      warnings.push(
        `${overdue.length} split deposit(s) served over ${hours(UNCLAIMED_WARN_MS)} ago are still unclaimed` +
          (lastError ? ` (last error: ${lastError})` : "") +
          ": if the merchant is switched off, the buyers can take them back.",
      );
    }
    if (splitClaims.failed > 0) warnings.push(`${splitClaims.failed} split deposit(s) no longer verify on L1 and were served unpaid.`);
    if (splitClaims.consumedUnknown > 0) {
      warnings.push(`${splitClaims.consumedUnknown} split deposit(s) were consumed by someone else: check the balance.`);
    }
    return {
      leader: this.leader,
      ...(consolidatedAt === undefined ? {} : { consolidatedAt }),
      unconsolidated,
      proofsNotTakenIn: new Set(notTakenIn.map((p) => p.paymentRef)).size,
      splitClaims,
      warnings,
    };
  }

  /**
   * Pending claims served at least {@link UNCLAIMED_WARN_MS} ago, the most
   * recently updated first. A claim is stored with its reference's served
   * mark, which says when; a mark already swept means a very old claim.
   */
  private async overdueClaims(pending: StoredSplitClaim[], now: number): Promise<StoredSplitClaim[]> {
    const overdue: StoredSplitClaim[] = [];
    for (const c of pending) {
      const mark = await this.opts.store.served(c.paymentRef);
      if (!mark || now - mark.at >= UNCLAIMED_WARN_MS) overdue.push(c);
    }
    return overdue.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** The leader logs what needs a person; the others stay quiet, so each warning is logged once. */
  private async logWarnings(): Promise<void> {
    if (!this.leader) return;
    for (const warning of (await this.status()).warnings) this.log(`WARNING: ${warning}`);
  }

  /** One pass over the pending split claims that are due. */
  claimDue(): Promise<void> {
    const split = this.opts.split;
    if (!split) return Promise.resolve();
    return this.run(async () => {
      for (const c of await this.opts.store.splitClaims("pending")) {
        if (c.nextTryAt > this.now()) continue;
        await this.claimOne(split, c);
      }
    });
  }

  private async claimOne(split: SplitClaimer, c: StoredSplitClaim): Promise<void> {
    const store = this.opts.store;
    const attempts = c.attempts + 1;
    const later = { attempts, nextTryAt: this.now() + backoff(c.attempts) };
    let outcome: SplitClaimOutcome;
    try {
      outcome = await split.claim(c.claim);
    } catch (error) {
      // A busy sponsor or a node hiccup: nothing was consumed, try again later.
      await store.updateSplitClaim(c.paymentRef, { ...later, lastError: String(error) });
      return;
    }
    if (outcome === "claimed") {
      await store.updateSplitClaim(c.paymentRef, { status: "claimed", attempts, lastError: undefined });
      this.log(`Claimed the split deposit of ${c.paymentRef}.`);
    } else if (outcome === "consumed-unknown") {
      await store.updateSplitClaim(c.paymentRef, { status: "consumed-unknown", attempts });
      this.log(
        `The split deposit of ${c.paymentRef} was consumed by someone else: claimed for us (check the balance) or returned to the buyer.`,
      );
    } else if (attempts % REBUILD_EVERY === 0) {
      const rebuilt = await split.rebuild(c.claim).catch(() => c.claim);
      if (rebuilt === undefined) {
        await store.updateSplitClaim(c.paymentRef, { status: "failed", attempts, lastError: "the deposit no longer verifies on L1" });
        this.log(`The split deposit of ${c.paymentRef} no longer verifies on L1 (reorged out?); it was served unpaid.`);
      } else {
        await store.updateSplitClaim(c.paymentRef, { ...later, claim: rebuilt, lastError: "message not consumable yet" });
      }
    } else {
      await store.updateSplitClaim(c.paymentRef, { ...later, lastError: "message not consumable yet" });
    }
  }
}
