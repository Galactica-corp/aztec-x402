/**
 * `pay --from-ethereum`: pay a merchant's `split` offer with one deposit the
 * user signs in their own browser wallet, and `fund change` to collect what
 * the deposit leaves over into the agent's Aztec account.
 *
 *   1. The split terms are checked against the agent's own bridge manifest
 *      and the spend policy (on the price), and the deposit is drafted from a
 *      round amount, never the price.
 *   2. The draft is stored (its salts are the only way to the change), then
 *      the funding page shows the user what to sign: Permit2 approval once,
 *      the deposit permit, the deposit.
 *   3. The agent finds the deposit on L1, stores the proof and hands it to the
 *      merchant, resending while the deposit is not deep enough.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr } from "@aztec-labs/aztec.js/fields";
import {
  BindConsentRequiredError,
  NotFundingAddressError,
  changeOf,
  MessageNotConsumableError,
  changeState,
  claimChange,
  claimSplit,
  isBridgePaused,
  prepareSplitDeposit,
  registerBridgeContracts,
  registerSponsor,
  syncMerchantList,
  waitSplitClaimable,
  type BridgeManifest,
} from "@galactica-net/inference-money-core";
import type { PaymentPayload, PaymentRequirements } from "@galactica-net/x402-mechanism";
import { SplitTermsSchema, parseAztecPaymentExtra, parsePrice } from "@galactica-net/x402-core";
import { loadAccountKeys } from "../aztec/keystore.js";
import { createNodeClient } from "../aztec/node-client.js";
import { openSession } from "../aztec/session.js";
import { fundPageUrl, type ResolvedContext } from "../config.js";
import { CliError, UsageError, messageOf } from "../errors.js";
import { encodePlan, openBrowser } from "./fund.js";
import { startFundServer } from "../fund/server.js";
import {
  assertSplitTerms,
  bridgeManifestFor,
  buildSplitPlan,
  chooseDeposit,
  confirmSplitDeposit,
  draftOf,
  encodeTicket,
  findSplitDeposit,
  proofOfTicket,
  readSplitRecords,
  saveSplitRecord,
  splitL1,
  ticketOf,
  type SplitRecord,
} from "../fund/split.js";
import { toHex } from "../fund/bridge.js";
import { progress } from "../output.js";
import { appendLedger, checkPayment } from "../policy.js";
import { saveStoredPayment } from "../proofs.js";
import { formatTokenAmount } from "../x402.js";
import type { PayOptions, SerializedRequest } from "./pay.js";

const L1_POLL_MS = 6_000;
/** The permit lives 30 min from drafting; a deposit not seen well after that will not come. */
const DEPOSIT_WAIT_MS = 40 * 60_000;
/**
 * A deposit its merchant has not claimed this long after the payment began
 * (the deposit follows within the permit's 30 min) is claimed by the agent:
 * the merchant claims within minutes, so one that has not by now lost its
 * claim data or never served. Anyone may claim, the merchant gets the price
 * either way, and only then is the change released.
 */
export const SELF_CLAIM_AFTER_MS = 24 * 60 * 60_000;
/** Deposit hashes the local page may report per payment; each is checked on L1. */
const MAX_DEPOSIT_HINTS = 8;

const usdc = (v: bigint) => formatTokenAmount(v, { symbol: "USDC", name: "USDC", address: "", decimals: 6 });

function manifestFor(ctx: ResolvedContext): BridgeManifest {
  const m = bridgeManifestFor(ctx.network);
  if (!m) {
    throw new UsageError(
      `No inference-money bridge is known for network ${ctx.network.name}; set AZTEC_X402_BRIDGE_MANIFEST to its manifest file.`,
      "no_bridge",
    );
  }
  return m;
}

export interface SplitStart {
  id: string;
  url: string;
  init: SerializedRequest;
  accepted: PaymentRequirements;
  x402Version: number;
  opts: PayOptions;
}

export async function paySplit(ctx: ResolvedContext, s: SplitStart) {
  const m = manifestFor(ctx);
  const terms = SplitTermsSchema.parse(s.accepted.extra);
  const paymentRef = parseAztecPaymentExtra(s.accepted.extra).paymentRef;
  if (!paymentRef) throw new CliError("The merchant's split offer has no payment reference", "bad_challenge");
  assertSplitTerms(terms, m, s.accepted);
  if (s.accepted.asset.toLowerCase() !== m.l2.token.address.toLowerCase()) {
    throw new CliError("The split offer is for another token than this bridge's USDC.", "split_terms_mismatch");
  }
  const token = checkPayment(s.accepted, s.opts, ctx.policy, ctx.network, ctx.dataDir);
  const price = BigInt(s.accepted.amount);
  const amount = chooseDeposit(terms, s.opts.deposit ? parsePrice(s.opts.deposit, 6) : undefined);
  const keys = loadAccountKeys(ctx.dataDir);
  if (!keys) throw new UsageError("No agent wallet. Run `aztec-x402 wallet create` first.", "no_wallet");
  if (!s.opts.wait && !s.opts.hosted) throw new UsageError("--no-wait needs --hosted: the local page lives only while `pay` runs");
  progress(
    `Price: ${usdc(price)} USDC to ${s.accepted.payTo} — within policy. The user deposits ${usdc(amount)} USDC on ${ctx.network.l1ChainName}; the agent collects ${usdc(amount - price)} USDC change later.`,
  );

  const node = createNodeClient(ctx.network.nodeUrl);
  if (await isBridgePaused(node, m)) throw new CliError("The bridge is paused; a deposit now could not be claimed until it resumes.", "bridge_paused");
  const l1 = splitL1(ctx.network.l1RpcUrl);
  const [latest, finalized] = await Promise.all([l1.getBlock({ blockTag: "latest" }), l1.getBlock({ blockTag: "finalized" })]);
  const draft = await prepareSplitDeposit(
    {
      amount,
      merchant: AztecAddress.fromStringUnsafe(terms.merchant),
      price,
      paymentRef: Fr.fromHexString(paymentRef),
      buyer: AztecAddress.fromStringUnsafe(keys.address),
    },
    m,
    () => latest.timestamp,
    await syncMerchantList(node, AztecAddress.fromStringUnsafe(m.l2.token.address)),
  );
  const record: SplitRecord = {
    id: s.id,
    createdAt: new Date().toISOString(),
    url: s.url,
    request: s.init,
    accepted: s.accepted,
    price: price.toString(),
    amount: amount.toString(),
    draft: encodeTicket("draft", draft),
    l1FromBlock: (finalized.number ?? 0n).toString(),
    status: "awaiting_deposit",
  };
  saveSplitRecord(ctx.dataDir, record);
  appendLedger(ctx.dataDir, {
    id: s.id,
    status: "pending",
    url: s.url,
    network: ctx.network.caip2,
    asset: token.address,
    token: token.symbol,
    amount: usdc(price),
    amountBaseUnits: price.toString(),
    payTo: s.accepted.payTo,
    nonce: parseAztecPaymentExtra(s.accepted.extra).nonce,
    mode: "split",
    paymentRef,
  });
  const plan = buildSplitPlan(ctx.network, m, draft, keys.address, s.accepted.payTo, price.toString(), usdc);

  let phase: "signing" | "waiting_l1" | "paying" | "done" | "failed" = "signing";
  let error: string | undefined;
  // What the page reports is a hint, never trusted: finishSplit uses a hash
  // only once it confirms as this draft's deposit, and searches L1 for the
  // deposit all the same. A caller with the page token cannot pin a wrong one.
  const hints = new Set<string>();
  let server: Awaited<ReturnType<typeof startFundServer>> | undefined;
  if (s.opts.hosted) {
    const link = `${fundPageUrl()}#${encodePlan(plan)}`;
    progress(`Payment page: ${link}`);
    if (!s.opts.wait) {
      return {
        url: s.url,
        paid: false,
        pending: true,
        id: s.id,
        link,
        next: `After the user deposits (within 30 minutes), run \`aztec-x402 pay --resume ${s.id}\`.`,
      };
    }
  } else {
    server = await startFundServer(
      {
        async state() {
          return { plan, phase, error };
        },
        async submitted({ l1TxHash }) {
          if (hints.size >= MAX_DEPOSIT_HINTS) return { accepted: false, reason: "too many reports" };
          hints.add(l1TxHash.toLowerCase());
          if (phase === "signing") phase = "waiting_l1";
          progress(`The page reports the deposit ${l1TxHash}; checking it on L1.`);
          return { accepted: true };
        },
      },
      { host: s.opts.host, port: s.opts.port },
    );
    progress(`Payment page: ${server.url}`);
    if (s.opts.open !== false) openBrowser(server.url);
  }
  progress(`Ask the user to open it, connect a ${ctx.network.l1ChainName} wallet with ${usdc(amount)} USDC, and sign. Waiting for the deposit...`);

  try {
    const result = await finishSplit(ctx, record, m, s.x402Version, s.opts, (p) => (phase = p), () => [...hints]);
    phase = "done";
    if (server) await new Promise((r) => setTimeout(r, 6000));
    return result;
  } catch (e) {
    error = messageOf(e);
    phase = "failed";
    if (server) await new Promise((r) => setTimeout(r, 6000));
    throw e;
  } finally {
    await server?.close();
  }
}

export class DepositTimeoutError extends Error {}

/**
 * Waits for a split deposit and confirms it. Each round searches L1 for it
 * (`find`, by the draft's secret hash) and tries every reported hash
 * (`hints`). A candidate that `confirm` rejects with a CliError is not this
 * draft's deposit and is never tried again; any other error means not mined
 * or not visible yet. Gives up at `deadline` unless the search has found the
 * deposit (then it waits for it to confirm).
 */
export async function awaitSplitDeposit<T>(o: {
  find: () => Promise<string | undefined>;
  confirm: (hash: string) => Promise<T>;
  hints: () => string[];
  deadline: number;
  pollMs: number;
  onFound?: (hash: string) => void;
}): Promise<{ ticket: T; l1TxHash: string }> {
  const rejected = new Set<string>();
  for (;;) {
    const found = (await o.find().catch(() => undefined))?.toLowerCase();
    const candidates = [...new Set([...(found ? [found] : []), ...o.hints().map((h) => h.toLowerCase())])].filter((h) => !rejected.has(h));
    for (const candidate of candidates) {
      try {
        return { ticket: await o.confirm(candidate), l1TxHash: candidate };
      } catch (error) {
        if (error instanceof CliError) rejected.add(candidate);
      }
    }
    const live = found !== undefined && !rejected.has(found);
    if (!live && Date.now() > o.deadline) throw new DepositTimeoutError();
    if (live) o.onFound?.(found);
    await new Promise((r) => setTimeout(r, o.pollMs));
  }
}

/**
 * From a stored record: find the deposit, confirm it, hand the merchant the
 * proof. The deposit is searched on L1 by this draft's secret hash; hashes
 * reported by the page (`hints`) are tried too, and dropped when they are not
 * this draft's deposit. A hash is stored only once it confirms.
 */
async function finishSplit(
  ctx: ResolvedContext,
  start: SplitRecord,
  m: BridgeManifest,
  x402Version: number,
  opts: PayOptions,
  onPhase: (p: "waiting_l1" | "paying") => void = () => {},
  hints: () => string[] = () => [],
) {
  const { deliver } = await import("./pay.js");
  const l1 = splitL1(ctx.network.l1RpcUrl);
  const draft = draftOf(start);
  const current = () => readSplitRecords(ctx.dataDir).find((r) => r.id === start.id) ?? start;
  let record = current();

  let ticket = ticketOf(record);
  if (!ticket) {
    const fromBlock = BigInt(record.l1FromBlock);
    const stored = record.l1TxHash;
    let announced = false;
    const confirmed = await awaitSplitDeposit({
      find: () => findSplitDeposit(l1, m, draft, fromBlock),
      confirm: (hash) => confirmSplitDeposit(l1, m, draft, toHex(hash)),
      // A hash stored by an older version is a hint like any other.
      hints: () => [...hints(), ...(stored ? [stored] : [])],
      deadline: Date.parse(record.createdAt) + DEPOSIT_WAIT_MS,
      pollMs: L1_POLL_MS,
      onFound(hash) {
        if (announced) return;
        announced = true;
        onPhase("waiting_l1");
        progress(`Found the deposit ${hash}; waiting for it to be mined...`);
      },
    }).catch((error: unknown) => {
      if (error instanceof DepositTimeoutError) {
        throw new CliError(`No deposit seen on L1 for payment ${record.id}; its permit has expired, so it can no longer be sent.`, "deposit_timeout");
      }
      throw error;
    });
    ticket = confirmed.ticket;
    const l1TxHash = confirmed.l1TxHash;
    record = { ...current(), l1TxHash, ticket: encodeTicket("claim", ticket), status: "deposited" };
    saveSplitRecord(ctx.dataDir, record);
  }

  const payload: PaymentPayload = { x402Version, accepted: record.accepted, payload: { mode: "split", ...proofOfTicket(ticket) } };
  saveStoredPayment(ctx.dataDir, { id: record.id, url: record.url, request: record.request, payload, createdAt: record.createdAt });
  appendLedger(ctx.dataDir, { id: record.id, status: "paid", txHash: record.l1TxHash });
  onPhase("paying");
  progress("Handing the merchant the payment (it serves once the deposit is a few blocks deep)...");
  try {
    const result = await deliver(
      ctx,
      record.id,
      record.url,
      record.request,
      payload,
      { token: "USDC", amount: usdc(BigInt(record.price)), payTo: record.accepted.payTo, deposit: usdc(BigInt(record.amount)) },
      opts.output,
    );
    saveSplitRecord(ctx.dataDir, { ...current(), status: "served" });
    return { ...result, change: { amount: usdc(BigInt(record.amount) - BigInt(record.price)), collect: "aztec-x402 fund change" } };
  } catch (error) {
    const code = error instanceof CliError ? error.code : undefined;
    const status = code === "response_lost" ? "response_lost" : code === "payment_superseded" ? "superseded" : "not_served";
    saveSplitRecord(ctx.dataDir, { ...current(), status, error: messageOf(error) });
    throw error;
  }
}

/** `pay --resume <id>` for a split payment: undefined when `id` is not one. */
export function resumeSplit(ctx: ResolvedContext, id: string, opts: PayOptions): Promise<object> | undefined {
  const record = readSplitRecords(ctx.dataDir).find((r) => r.id === id);
  if (!record) return undefined;
  if (record.status === "served" || record.status.startsWith("change_")) {
    return Promise.reject(new UsageError(`Payment ${id} was already delivered; it is not served twice.`, "already_delivered"));
  }
  if (record.status === "response_lost") {
    return Promise.reject(
      new CliError(`The merchant served payment ${id}, but its response was lost; it cannot be delivered again.`, "response_lost", {
        payment: { id, l1TxHash: record.l1TxHash },
      }),
    );
  }
  if (record.status === "superseded") {
    return Promise.reject(
      new CliError(
        `The merchant served another payment under this request's reference instead of payment ${id}; it will not serve it. ` +
          "Run `aztec-x402 fund change` to collect its change.",
        "payment_superseded",
        { payment: { id, l1TxHash: record.l1TxHash } },
      ),
    );
  }
  progress(`Resuming payment ${id} from Ethereum...`);
  return finishSplit(ctx, record, manifestFor(ctx), 2, opts);
}

/** `fund change`: collect the change every split deposit owes the agent, once the merchant has claimed it. */
export async function collectChange(ctx: ResolvedContext, opts: { allowBind: boolean }) {
  const open = readSplitRecords(ctx.dataDir).filter((r) => r.ticket && !r.status.startsWith("change_"));
  if (open.length === 0) return { collected: [], waiting: [], note: "No change to collect." };
  const m = manifestFor(ctx);
  const node = createNodeClient(ctx.network.nodeUrl);
  const collected = [];
  const waiting = [];
  const failed = [];
  let session: Awaited<ReturnType<typeof openSession>> | undefined;
  for (const record of open) {
    const ticket = ticketOf(record);
    const change = ticket ? changeOf(ticket) : undefined;
    if (!change) {
      saveSplitRecord(ctx.dataDir, { ...record, status: "change_collected" });
      continue;
    }
    const amount = usdc(change.amount);
    const state = await changeState(change, node, m);
    if (state === "settled") {
      saveSplitRecord(ctx.dataDir, { ...record, status: "change_collected" });
      collected.push({ id: record.id, amount, note: "already collected" });
      continue;
    }
    // A superseded deposit is never claimed by the merchant, and one left unclaimed past the grace likely never will
    // be: the agent claims it (paying the merchant the price, as any claim does) so its change can be collected.
    const selfClaimAt = Date.parse(record.createdAt) + SELF_CLAIM_AFTER_MS;
    const overdue = !(Date.now() < selfClaimAt);
    const claimItself = state === "unclaimed" && (record.status === "superseded" || overdue);
    if (state === "unclaimed" && !claimItself) {
      waiting.push({
        id: record.id,
        amount,
        reason: "the merchant has not claimed the deposit on Aztec yet (minutes after it served)",
        selfClaimAfter: new Date(selfClaimAt).toISOString(),
      });
      continue;
    }
    if (!session) {
      progress("Opening wallet and syncing private state...");
      session = await openSession(ctx.network, ctx.dataDir);
      await registerSponsor(session.wallet, m);
      await registerBridgeContracts(session.wallet, m);
    }
    try {
      if (claimItself) {
        progress(
          record.status === "superseded"
            ? `The merchant served another payment instead of ${record.id}; claiming its deposit to release the change...`
            : `The merchant has not claimed the deposit of ${record.id} in ${SELF_CLAIM_AFTER_MS / 3_600_000} h; claiming it to release the change...`,
        );
        await waitSplitClaimable(change.claim, node, session.wallet, m, change.buyer, undefined, { attempts: 1, pollMs: 0 });
        await claimSplit(change.claim, node, session.wallet, m, { from: change.buyer });
      }
      progress(`Collecting ${amount} USDC change of payment ${record.id}...`);
      const tx = await claimChange(change, node, session.wallet, m, { allowBind: opts.allowBind });
      saveSplitRecord(ctx.dataDir, { ...record, status: "change_collected", changeTxHash: tx.toString() });
      collected.push({ id: record.id, amount, txHash: tx.toString() });
    } catch (error) {
      if (error instanceof MessageNotConsumableError) {
        waiting.push({ id: record.id, amount, reason: "the deposit is not claimable on Aztec yet (minutes after it was made)" });
        continue;
      }
      if (error instanceof BindConsentRequiredError) {
        throw new CliError(
          `Collecting the change binds this agent's account to ${error.depositor} for good: later deposits from other L1 addresses cannot be collected. Run \`aztec-x402 fund change --allow-bind\` to accept.`,
          "bind_consent_required",
          { depositor: error.depositor },
        );
      }
      if (error instanceof NotFundingAddressError) {
        failed.push({
          id: record.id,
          amount,
          code: "not_funding_address",
          error: `This agent is bound to ${error.fundingAddress}; change from ${error.depositor} can only be returned to Ethereum, which publishes its amount (and with it the price).`,
        });
        continue;
      }
      failed.push({ id: record.id, amount, error: messageOf(error) });
    }
  }
  return { collected, waiting, failed };
}
