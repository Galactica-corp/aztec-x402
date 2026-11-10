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
 *   that was, so restarts neither skip nor repeat it). A failed run is
 *   retried within minutes, not at the next scheduled run.
 * - Claim every served split deposit on Aztec once its message is
 *   consumable, retrying with backoff (a busy sponsor, a slow message), and
 *   rebuilding the claim from the buyer's proof if an L1 reorg moved the
 *   deposit. State lives in the store, so a restart resumes where it stopped.
 */
import {
  OFFCHAIN_MESSAGE_TTL_MS,
  RefAztecPayloadSchema,
  type ModeVerification,
  type PaymentStateStore,
  type RefPaymentProof,
  type StoredSplitClaim,
} from "@galactica-net/x402-core";
import type { SplitClaimOutcome } from "./split-merchant.js";

/** The split side the jobs need; {@link SplitMerchant} is the real one. */
export interface SplitClaimer {
  claim(claimJson: string): Promise<SplitClaimOutcome>;
  /** The claim rebuilt from L1 as it is now, or undefined when the deposit no longer verifies. */
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
  log?: (message: string) => void;
  now?: () => number;
}

const MIN_BACKOFF_MS = 15_000;
const MAX_BACKOFF_MS = 10 * 60_000;
/** The wait after the `attempts`-th failure in a row: 30 s, doubling, at most 10 min. */
const backoff = (attempts: number) => Math.min(MIN_BACKOFF_MS * 2 ** Math.min(attempts, 10), MAX_BACKOFF_MS);
/** After this many attempts finding the message not consumable, check whether an L1 reorg moved the deposit. */
const REBUILD_EVERY = 10;

export class MerchantJobs {
  private queue: Promise<unknown> = Promise.resolve();
  private timers: ReturnType<typeof setInterval>[] = [];
  private consolidationTimer?: ReturnType<typeof setTimeout>;
  private consolidationFailures = 0;
  private stopped = false;
  private readonly log: (message: string) => void;
  private readonly now: () => number;

  constructor(private readonly opts: MerchantJobsOptions) {
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
  }

  /** Runs `task` after every task queued before it: the merchant's wallet is used by one job at a time. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Replays stored proofs, consolidates if anything is new, then consolidates and claims on their schedules. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.replayProofs();
    if (this.opts.consolidate) void this.consolidationTick();
    if (this.opts.split) {
      this.timers.push(setInterval(() => void this.claimDue().catch(() => undefined), this.opts.claimPollMs ?? 30_000));
      void this.claimDue().catch(() => undefined);
    }
  }

  /** Stops scheduling; resolves once the running job is done. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.timers.splice(0).forEach(clearInterval);
    clearTimeout(this.consolidationTimer);
    await this.queue;
  }

  /** Takes in every ref proof stored within the message lifetime and never taken in. */
  replayProofs(): Promise<{ taken: number; pending: number }> {
    return this.run(async () => {
      let taken = 0;
      let pending = 0;
      for (const stored of await this.opts.store.proofsNotTakenIn(this.now() - OFFCHAIN_MESSAGE_TTL_MS)) {
        const parsed = RefAztecPayloadSchema.safeParse(JSON.parse(stored.payload));
        if (!parsed.success) continue;
        const { mode: _mode, ...proof } = parsed.data;
        try {
          const result = await this.opts.receive(stored.asset, proof, { paymentRef: stored.paymentRef, price: BigInt(stored.price) });
          if (result.isValid) {
            await this.opts.store.markTakenIn(stored.paymentRef);
            taken++;
          } else {
            pending++;
            if (!result.retryable) this.log(`Stored proof for ${stored.paymentRef} does not pay: ${result.error ?? result.reason}`);
          }
        } catch (error) {
          pending++;
          this.log(`Taking in the stored proof for ${stored.paymentRef} failed: ${String(error)}`);
        }
      }
      if (taken + pending > 0) this.log(`Replayed stored payment proofs: ${taken} taken in, ${pending} not.`);
      return { taken, pending };
    });
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
        if (last !== undefined && (await store.takenInSince(last)) === 0) return false;
      }
      const startedAt = this.now();
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
    let delay = this.opts.consolidateEveryMs ?? 6 * 3600_000;
    try {
      await this.consolidateIfDue();
      this.consolidationFailures = 0;
    } catch {
      this.consolidationFailures++;
      delay = Math.min(delay, backoff(this.consolidationFailures));
      this.log(`Retrying the consolidation in ${Math.round(delay / 1000)} s.`);
    }
    if (!this.stopped) this.consolidationTimer = setTimeout(() => void this.consolidationTick(), delay);
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
