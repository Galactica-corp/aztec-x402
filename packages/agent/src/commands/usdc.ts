/**
 * `deposit` and `withdraw`: move the inference-money USDC between the user's
 * Ethereum wallet and the agent's private Aztec balance. The agent holds no
 * L1 key, so every L1 transaction is signed by the user on the funding page,
 * exactly as for `fund` and `pay --from-ethereum`.
 *
 * deposit:  binding consent (the first private claim binds the account to
 *           its depositor for good) → draft stored → the user approves
 *           Permit2 once, signs the permit, sends the deposit → the agent
 *           finds it on L1, waits for the message on Aztec and claims it.
 * withdraw: destination checked (a user exits only to its funding address)
 *           → record stored → burn on Aztec → wait for the epoch proof →
 *           the user sends the portal's withdraw (anyone may; the recipient
 *           is fixed) → the agent sees the message consumed.
 *
 * Both resume: `deposit claim`, `withdraw finish`.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { TxHash } from "@aztec-labs/aztec.js/tx";
import type { AztecNode } from "@aztec-labs/aztec.js/node";
import {
  ExitDestinationError,
  ExitRevertedError,
  ExitUnconfirmedError,
  MessageNotConsumableError,
  NotFundingAddressError,
  OUTBOX_ABI,
  buildWithdrawProof,
  claim,
  claimBinding,
  encodeTicket,
  exitToL1,
  fundingAddress,
  isBridgePaused,
  isExitWithdrawn,
  l2UsdcBalance,
  locateWithdrawal,
  merchantStatus,
  prepareDeposit,
  registerBridgeContracts,
  registerSponsor,
  syncMerchantList,
  waitClaimable,
  type BridgeManifest,
  type FeeChoice,
  type OutboxProof,
  type OutboxReader,
} from "@galactica-net/inference-money-core";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { parsePrice } from "@galactica-net/x402-core";
import { createPublicClient, getAddress, http, isAddress, type PublicClient } from "viem";
import { loadAccountKeys } from "../aztec/keystore.js";
import { createNodeClient } from "../aztec/node-client.js";
import { openSession, type Session } from "../aztec/session.js";
import { fundPageUrl, type ResolvedContext } from "../config.js";
import { CliError, UsageError, messageOf } from "../errors.js";
import { assertFeeConsent, assertHoldsFeeJuice } from "../fees.js";
import { toHex, type FundingPlan, type Hex } from "../fund/bridge.js";
import { startFundServer } from "../fund/server.js";
import { confirmSplitDeposit, findSplitDeposit, splitL1 } from "../fund/split.js";
import {
  buildUsdcDepositPlan,
  buildWithdrawPlan,
  depositDraftOf,
  depositTicketOf,
  exitTicketOf,
  isOpenWithdrawal,
  readUsdcDeposits,
  readUsdcWithdrawals,
  saveUsdcDeposit,
  saveUsdcWithdrawal,
  type UsdcDepositRecord,
  type UsdcWithdrawalRecord,
} from "../fund/usdc.js";
import { progress } from "../output.js";
import { formatTokenAmount } from "../x402.js";
import { encodePlan, openBrowser } from "./fund.js";
import { DepositTimeoutError, awaitSplitDeposit, manifestFor } from "./pay-split.js";

const L1_POLL_MS = 6_000;
/** How long after the permit's deadline a deposit is still looked for (it may have been mined just before it). */
const DEPOSIT_GRACE_MS = 10 * 60_000;
/** The L1→L2 message takes minutes; 30 min of polling before handing over to `deposit claim`. */
const CLAIMABLE_ATTEMPTS = 360;
/** Epochs prove on the order of tens of minutes to an hour; `withdraw` waits this long before `withdraw finish` takes over. */
const PROOF_WAIT_MS = 90 * 60_000;
const PROOF_POLL_MS = 60_000;
/** How long the withdraw page waits for the user's L1 transaction. */
const PAYOUT_WAIT_MS = 60 * 60_000;
const PAYOUT_POLL_MS = 12_000;
const MAX_HINTS = 8;

const usdc = (v: bigint) => formatTokenAmount(v, { symbol: "USDC", name: "USDC", address: "", decimals: 6 });

export interface PageOptions {
  hosted: boolean;
  wait: boolean;
  open: boolean;
  port?: number;
  host?: string;
}

function parseUsdc(amount: string | undefined, command: string): bigint {
  if (!amount) throw new UsageError(`Usage: aztec-x402 ${command} --amount N (USDC)`);
  const value = parsePrice(amount, 6);
  if (value <= 0n) throw new UsageError("--amount must be positive");
  return value;
}

function l1Reader(ctx: ResolvedContext): PublicClient {
  return createPublicClient({ transport: http(ctx.network.l1RpcUrl) });
}

/**
 * The L1 Outbox, read through this package's viem: the SDK's `outboxReader` takes a client of the newer viem it pins.
 * Same two reads as the SDK's.
 */
function outboxOf(l1: PublicClient, outbox: Hex): OutboxReader {
  return {
    async getRoots(epoch) {
      const roots = await l1.readContract({ address: outbox, abi: OUTBOX_ABI, functionName: "getRoots", args: [BigInt(epoch)] });
      return roots.map((r) => Fr.fromHexString(r));
    },
    isConsumed: (epoch, leafId) =>
      l1.readContract({ address: outbox, abi: OUTBOX_ABI, functionName: "hasMessageBeenConsumedAtEpoch", args: [epoch, leafId] }),
  };
}

/** A wallet session ready for bridge calls, and who pays their fees: the sponsor, or the account with the user's consent. */
async function bridgeSession(ctx: ResolvedContext, m: BridgeManifest, opts: { journal?: boolean } = {}) {
  const sponsored = ctx.network.sponsoredFees && m.l2.sponsoredFpc !== undefined;
  if (!sponsored) assertFeeConsent(ctx);
  progress("Opening wallet and syncing private state...");
  const session = await openSession(ctx.network, ctx.dataDir, { journal: opts.journal });
  if (sponsored) await registerSponsor(session.wallet, m);
  else await assertHoldsFeeJuice(ctx, session.node, session.address);
  await registerBridgeContracts(session.wallet, m);
  const fee: FeeChoice = sponsored ? "sponsored" : "account-public";
  return { session, fee };
}

type Phase = "signing" | "waiting_l1" | "waiting_message" | "claiming" | "done" | "failed";

/** Serves the plan (local page, or a hosted link), runs `work`, and keeps the page's phase in step with it. */
async function withPage<T extends object>(
  ctx: ResolvedContext,
  plan: FundingPlan,
  opts: PageOptions,
  pending: (link: string) => object,
  work: (setPhase: (p: Phase) => void, hints: () => string[], setBalance: (b: string) => void) => Promise<T>,
): Promise<T | object> {
  let phase: Phase = "signing";
  let error: string | undefined;
  let l2Balance: string | undefined;
  const hints = new Set<string>();
  let server: Awaited<ReturnType<typeof startFundServer>> | undefined;
  if (opts.hosted) {
    const link = `${fundPageUrl()}#${encodePlan(plan)}`;
    progress(`Page: ${link}`);
    if (!opts.wait) return pending(link);
  } else {
    server = await startFundServer(
      {
        async state() {
          return { plan, phase, l2Balance, error };
        },
        async submitted({ l1TxHash }) {
          // A hint only: the agent checks everything on L1 itself.
          if (hints.size >= MAX_HINTS) return { accepted: false, reason: "too many reports" };
          hints.add(l1TxHash.toLowerCase());
          if (phase === "signing") phase = "waiting_l1";
          progress(`The page reports ${l1TxHash}; checking it on L1.`);
          return { accepted: true };
        },
      },
      { host: opts.host, port: opts.port },
    );
    progress(`Page: ${server.url}`);
    for (const url of server.networkUrls) progress(`  from another machine: ${url}`);
    if (opts.open) openBrowser(server.url);
  }
  progress(`Ask the user to open it, connect a ${ctx.network.l1ChainName} wallet, and sign.`);
  try {
    const result = await work(
      (p) => (phase = p),
      () => [...hints],
      (b) => (l2Balance = b),
    );
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

// ── deposit ────────────────────────────────────────────────────────────────

export async function deposit(ctx: ResolvedContext, opts: PageOptions & { amount?: string; allowBind: boolean }) {
  const m = manifestFor(ctx);
  const keys = loadAccountKeys(ctx.dataDir);
  if (!keys) throw new UsageError("No agent wallet. Run `aztec-x402 wallet create` first.", "no_wallet");
  if (!opts.wait && !opts.hosted) throw new UsageError("--no-wait needs --hosted: the local page lives only while `deposit` runs");
  const amount = parseUsdc(opts.amount, "deposit");

  const node = createNodeClient(ctx.network.nodeUrl);
  const l1 = l1Reader(ctx);
  // The page also switches the wallet to this chain; a router whose rollup is no longer canonical refuses the deposit.
  const chainId = await l1.getChainId();
  if (chainId !== m.l1.chainId) {
    throw new CliError(`The L1 RPC is on chain ${chainId}, not the bridge's chain ${m.l1.chainId}.`, "network_mismatch");
  }
  if (await isBridgePaused(node, m)) throw new CliError("The bridge is paused; a deposit now could not be claimed until it resumes.", "bridge_paused");

  const { session, fee } = await bridgeSession(ctx, m);
  const bound = await fundingAddress(session.wallet, m, session.address);
  if (!bound && !opts.allowBind) {
    throw new CliError(
      `This account has never claimed a deposit: the first one binds it for good to the Ethereum address that makes it. ` +
        "Later deposits must come from that address, and a user account withdraws only there (a listed merchant anywhere, " +
        "but only there once switched off). Ask the user which address to deposit from, then rerun with --allow-bind.",
      "bind_consent_required",
    );
  }
  if (bound) progress(`This account is bound to ${bound}: deposit from that address only.`);

  const [latest, finalized] = await Promise.all([l1.getBlock({ blockTag: "latest" }), l1.getBlock({ blockTag: "finalized" })]);
  const draft = await prepareDeposit({ amount, recipient: session.address, kind: "private" }, m, () => latest.timestamp);
  let record: UsdcDepositRecord = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    recipient: session.address.toString(),
    amount: amount.toString(),
    draft: encodeTicket("draft", draft),
    l1FromBlock: (finalized.number ?? 0n).toString(),
    status: "awaiting_deposit",
  };
  saveUsdcDeposit(ctx.dataDir, record);
  const plan = buildUsdcDepositPlan(ctx.network, m, draft, keys.address, usdc, bound ? toHex(bound) : undefined);

  return withPage(
    ctx,
    plan,
    opts,
    (link) => ({
      network: ctx.network.name,
      agent: keys.address,
      amount: usdc(amount),
      depositId: record.id,
      url: link,
      next: "After the user deposits (within 30 minutes), run `aztec-x402 deposit claim`" + (bound ? "." : " --allow-bind."),
    }),
    async (setPhase, hints, setBalance) => {
      record = await finishDeposit(ctx, record, m, session, fee, opts.allowBind, setPhase, hints, true);
      const balance = usdc(await l2UsdcBalance(session.wallet, m, session.address, "private"));
      setBalance(`${balance} USDC`);
      return {
        network: ctx.network.name,
        agent: keys.address,
        amount: usdc(amount),
        depositId: record.id,
        depositor: record.depositor,
        l1TxHash: record.l1TxHash,
        status: record.status,
        ...(bound ? {} : { boundTo: record.depositor }),
        balance: `${balance} USDC`,
      };
    },
  );
}

/**
 * From a stored record: find the deposit on L1 (by the draft's secret hash, plus the page's reports), then wait for
 * its message on Aztec and claim it. With `waitForDeposit` false, looks once and reports a deposit not found yet.
 */
async function finishDeposit(
  ctx: ResolvedContext,
  start: UsdcDepositRecord,
  m: BridgeManifest,
  session: Session,
  fee: FeeChoice,
  allowBind: boolean,
  setPhase: (p: Phase) => void = () => {},
  hints: () => string[] = () => [],
  waitForDeposit = false,
): Promise<UsdcDepositRecord> {
  let record = start;
  const draft = depositDraftOf(record);
  let ticket = depositTicketOf(record);
  if (!ticket) {
    const l1 = splitL1(ctx.network.l1RpcUrl);
    const expires = Number(draft.typedData.message.deadline) * 1000 + DEPOSIT_GRACE_MS;
    let announced = false;
    const confirmed = await awaitSplitDeposit({
      find: () => findSplitDeposit(l1, m, draft, BigInt(record.l1FromBlock)),
      confirm: (hash) => confirmSplitDeposit(l1, m, draft, toHex(hash)),
      hints,
      deadline: waitForDeposit ? expires : 0,
      pollMs: L1_POLL_MS,
      onFound(hash) {
        if (announced) return;
        announced = true;
        setPhase("waiting_l1");
        progress(`Found the deposit ${hash}; waiting for it to be mined...`);
      },
    }).catch((error: unknown) => {
      if (!(error instanceof DepositTimeoutError)) throw error;
      if (Date.now() > expires) {
        saveUsdcDeposit(ctx.dataDir, { ...record, status: "not_deposited" });
        throw new CliError(`No deposit seen on L1 for ${record.id}; its permit has expired, so it can no longer be sent.`, "deposit_timeout");
      }
      throw new CliError(`The deposit ${record.id} is not on L1 yet.`, "deposit_not_found");
    });
    ticket = confirmed.ticket;
    record = {
      ...record,
      l1TxHash: confirmed.l1TxHash,
      ticket: encodeTicket("claim", ticket),
      depositor: ticket.depositor,
      status: "deposited",
    };
    saveUsdcDeposit(ctx.dataDir, record);
    progress(`Deposit ${confirmed.l1TxHash} from ${ticket.depositor} is mined.`);
  }

  try {
    const binding = await claimBinding(session.wallet, m, session.address, ticket.depositor);
    if (binding === "binds" && !allowBind) {
      throw new CliError(
        `Claiming binds this account for good to ${ticket.depositor}. Run \`aztec-x402 deposit claim --allow-bind\` to accept.`,
        "bind_consent_required",
        { depositor: ticket.depositor },
      );
    }
  } catch (error) {
    if (error instanceof NotFundingAddressError) {
      throw new CliError(
        `This account is bound to ${error.fundingAddress}; a deposit from ${error.depositor} cannot be claimed, only returned to its sender.`,
        "not_funding_address",
        { fundingAddress: error.fundingAddress, depositor: error.depositor },
      );
    }
    throw error;
  }

  setPhase("waiting_message");
  progress("Waiting for the deposit's message to reach Aztec (usually several minutes)...");
  try {
    await waitClaimable(ticket, session.node, session.wallet, m, session.address, undefined, {
      allowBind,
      attempts: CLAIMABLE_ATTEMPTS,
      pollMs: 5_000,
    });
  } catch (error) {
    if (error instanceof MessageNotConsumableError) {
      throw new CliError("The deposit's message has not reached Aztec yet. Run `aztec-x402 deposit claim` later.", "message_pending");
    }
    throw error;
  }
  setPhase("claiming");
  progress(`Claiming ${usdc(BigInt(record.amount))} USDC on Aztec...`);
  const result = await claim(ticket, session.node, session.wallet, m, { from: session.address, fee, allowBind });
  record = { ...record, status: result === "claimed" ? "claimed" : "consumed", error: undefined };
  saveUsdcDeposit(ctx.dataDir, record);
  return record;
}

/** `deposit claim`: finish every deposit that is not claimed yet. */
export async function depositClaim(ctx: ResolvedContext, opts: { allowBind: boolean }) {
  const open = readUsdcDeposits(ctx.dataDir).filter((r) => r.status === "awaiting_deposit" || r.status === "deposited");
  if (!open.length) return { claimed: [], waiting: [], failed: [], note: "No deposit to claim." };
  const m = manifestFor(ctx);
  const { session, fee } = await bridgeSession(ctx, m);
  const claimed = [];
  const waiting = [];
  const failed = [];
  for (const record of open) {
    const view = { id: record.id, amount: usdc(BigInt(record.amount)) };
    try {
      const done = await finishDeposit(ctx, record, m, session, fee, opts.allowBind);
      claimed.push({ ...view, l1TxHash: done.l1TxHash, status: done.status });
    } catch (error) {
      const code = error instanceof CliError ? error.code : undefined;
      if (code === "deposit_not_found" || code === "message_pending") waiting.push({ ...view, reason: messageOf(error) });
      else failed.push({ ...view, ...(code ? { code } : {}), error: messageOf(error) });
      if (code === "bind_consent_required") break;
    }
  }
  const balance = usdc(await l2UsdcBalance(session.wallet, m, session.address, "private"));
  return { claimed, waiting, failed, balance: `${balance} USDC` };
}

// ── withdraw ───────────────────────────────────────────────────────────────

export async function withdraw(ctx: ResolvedContext, opts: PageOptions & { amount?: string; to?: string }) {
  const m = manifestFor(ctx);
  const amount = parseUsdc(opts.amount, "withdraw");
  if (opts.to !== undefined && !isAddress(opts.to)) throw new UsageError(`--to is not an Ethereum address: ${opts.to}`);
  const open = readUsdcWithdrawals(ctx.dataDir).filter(isOpenWithdrawal);
  if (open.length) {
    throw new UsageError(
      `Withdrawal ${open[0]?.id} is not settled yet; run \`aztec-x402 withdraw finish\` first, so nothing is burned twice.`,
      "withdrawal_open",
    );
  }

  const { session, fee } = await bridgeSession(ctx, m, { journal: true });
  const journal = session.journal;
  if (!journal) throw new Error("bridge session opened without a send journal");
  const list = await syncMerchantList(session.node, AztecAddress.fromStringUnsafe(m.l2.token.address));
  const asMerchant = merchantStatus(list, session.address).merchant;
  const bound = await fundingAddress(session.wallet, m, session.address);
  const recipient = opts.to ? getAddress(opts.to) : bound;
  if (!recipient) {
    throw new UsageError(
      asMerchant
        ? "This merchant account is not bound to an Ethereum address: name the recipient with --to."
        : "This account has never claimed a deposit, so it has no funding address, and a user account withdraws only there.",
      asMerchant ? "usage" : "not_bound",
    );
  }
  if (!asMerchant && bound && recipient.toLowerCase() !== bound.toLowerCase()) {
    throw new CliError(`A user account withdraws only to its funding address ${bound}, not ${recipient}.`, "exit_destination", {
      fundingAddress: bound,
    });
  }
  const balance = await l2UsdcBalance(session.wallet, m, session.address, "private");
  if (balance < amount) {
    throw new CliError(`The account holds ${usdc(balance)} USDC privately, less than ${usdc(amount)}.`, "insufficient_balance");
  }

  let record: UsdcWithdrawalRecord = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    from: session.address.toString(),
    recipient,
    amount: amount.toString(),
    asMerchant,
    status: "exiting",
  };
  saveUsdcWithdrawal(ctx.dataDir, record);
  progress(`Burning ${usdc(amount)} USDC on Aztec for ${recipient} (proving takes a minute or two)...`);
  try {
    const ticket = await exitToL1({ kind: "private", from: session.address, recipientL1: recipient, amount, asMerchant }, session.wallet, journal, m, { fee });
    record = { ...record, status: "exited", l2TxHash: ticket.l2TxHash.toString(), ticket: encodeTicket("exit", ticket) };
    saveUsdcWithdrawal(ctx.dataDir, record);
  } catch (error) {
    if (error instanceof ExitUnconfirmedError) {
      saveUsdcWithdrawal(ctx.dataDir, { ...record, status: "unconfirmed", l2TxHash: error.l2TxHash.toString(), error: messageOf(error) });
      throw new CliError(
        `The burn ${error.l2TxHash} was sent but is not confirmed. Do not withdraw again: run \`aztec-x402 withdraw finish\`.`,
        "exit_unconfirmed",
        { id: record.id, l2TxHash: error.l2TxHash.toString() },
      );
    }
    if (error instanceof ExitRevertedError) {
      saveUsdcWithdrawal(ctx.dataDir, {
        ...record,
        status: error.final ? "reverted" : "unconfirmed",
        l2TxHash: error.l2TxHash.toString(),
        error: messageOf(error),
      });
      throw new CliError(`The burn ${error.l2TxHash} reverted; nothing was burned.`, "exit_reverted", { id: record.id });
    }
    // Every failure before the tx reaches the node burned nothing.
    saveUsdcWithdrawal(ctx.dataDir, { ...record, status: "reverted", error: messageOf(error) });
    if (error instanceof ExitDestinationError) {
      throw new CliError(`The bridge refuses ${error.recipient} as this account's destination.`, "exit_destination");
    }
    throw error;
  }
  progress(`Burned in ${record.l2TxHash}. Waiting for its epoch to be proven on ${ctx.network.l1ChainName} (often an hour or more)...`);
  if (!opts.wait) return pendingWithdrawal(ctx, record, "The burn landed; its epoch is not proven yet.");
  return payOut(ctx, record, m, session.node, opts, PROOF_WAIT_MS);
}

function pendingWithdrawal(ctx: ResolvedContext, record: UsdcWithdrawalRecord, note: string, link?: string) {
  return {
    network: ctx.network.name,
    id: record.id,
    amount: usdc(BigInt(record.amount)),
    recipient: record.recipient,
    l2TxHash: record.l2TxHash,
    withdrawn: false,
    pending: true,
    note,
    ...(link ? { url: link } : {}),
    next: "Run `aztec-x402 withdraw finish` to send the payout on L1 once the epoch is proven.",
  };
}

/** Waits up to `proofWaitMs` for the epoch proof, then has the user send the portal's withdraw and waits for it. */
async function payOut(
  ctx: ResolvedContext,
  start: UsdcWithdrawalRecord,
  m: BridgeManifest,
  node: AztecNode,
  opts: PageOptions,
  proofWaitMs: number,
): Promise<object> {
  let record = start;
  const ticket = exitTicketOf(record);
  if (!ticket) throw new Error(`withdrawal ${record.id} has no exit ticket`);
  const outbox = outboxOf(l1Reader(ctx), m.l1.outbox);
  const done = () => ({
    network: ctx.network.name,
    id: record.id,
    amount: usdc(ticket.amount),
    recipient: ticket.recipient,
    l2TxHash: record.l2TxHash,
    l1TxHash: record.l1TxHash,
    withdrawn: true,
  });
  if (await isExitWithdrawn(ticket, node, outbox)) {
    record = { ...record, status: "withdrawn" };
    saveUsdcWithdrawal(ctx.dataDir, record);
    return done();
  }

  let proof: OutboxProof | undefined;
  const until = Date.now() + proofWaitMs;
  for (;;) {
    const built = await buildWithdrawProof(ticket, node, outbox);
    if (built !== "pending") {
      proof = built;
      break;
    }
    if (Date.now() >= until) return pendingWithdrawal(ctx, record, "The epoch holding the burn is not proven on L1 yet.");
    await new Promise((r) => setTimeout(r, PROOF_POLL_MS));
  }

  progress("The epoch is proven; the payout can be sent on L1.");
  const plan = buildWithdrawPlan(ctx.network, m, ticket, proof, record.from, usdc);
  return withPage(
    ctx,
    plan,
    opts,
    (link) => pendingWithdrawal(ctx, record, "The payout is ready to send from the page.", link),
    async (setPhase, hints) => {
      const deadline = Date.now() + PAYOUT_WAIT_MS;
      for (;;) {
        if (await isExitWithdrawn(ticket, node, outbox)) break;
        if (hints().length) setPhase("waiting_l1");
        if (Date.now() > deadline) {
          throw new CliError("The payout was not sent within 60 minutes. Run `aztec-x402 withdraw finish` to try again.", "payout_timeout");
        }
        await new Promise((r) => setTimeout(r, PAYOUT_POLL_MS));
      }
      // The page's report names the tx; the consumed message is what proves the payout.
      record = { ...record, status: "withdrawn", l1TxHash: hints()[0] };
      saveUsdcWithdrawal(ctx.dataDir, record);
      return done();
    },
  );
}

/** `withdraw finish`: settle burns whose outcome was unknown, then pay out the oldest one that is ready. */
export async function withdrawFinish(ctx: ResolvedContext, opts: PageOptions) {
  const m = manifestFor(ctx);
  const node = createNodeClient(ctx.network.nodeUrl);
  const settled = [];
  for (const record of readUsdcWithdrawals(ctx.dataDir).filter(isOpenWithdrawal)) {
    if (record.status === "exiting") {
      // Interrupted before any hash was known: whether it burned shows only in the balance.
      saveUsdcWithdrawal(ctx.dataDir, { ...record, status: "unknown" });
      settled.push({ id: record.id, status: "unknown", note: "Interrupted before the burn was sent or its hash known; check `balance` before withdrawing again." });
      continue;
    }
    if (record.status === "unconfirmed" && record.l2TxHash) {
      const found = await locateWithdrawal(toHex(record.recipient), BigInt(record.amount), TxHash.fromString(record.l2TxHash), node, m).catch(
        (error: unknown) => {
          settled.push({ id: record.id, status: "unconfirmed", note: `Not checkpointed yet: ${messageOf(error)}` });
          return undefined;
        },
      );
      if (found === "reverted") {
        saveUsdcWithdrawal(ctx.dataDir, { ...record, status: "reverted" });
        settled.push({ id: record.id, status: "reverted", note: "The burn reverted; nothing was burned." });
      } else if (found && found !== "reverted-unfinalized") {
        saveUsdcWithdrawal(ctx.dataDir, { ...record, status: "exited", ticket: encodeTicket("exit", found) });
      } else if (found === "reverted-unfinalized") {
        settled.push({ id: record.id, status: "unconfirmed", note: "Reverted in a block that is not final yet; check again later." });
      }
    }
  }
  const ready = readUsdcWithdrawals(ctx.dataDir).filter((r) => r.status === "exited");
  if (!ready.length) return { settled, note: settled.length ? "Nothing to pay out." : "No withdrawal to finish." };
  const [first, ...rest] = ready;
  if (!first) return { settled };
  const result = await payOut(ctx, first, m, node, opts, 0);
  return { ...result, settled, ...(rest.length ? { more: rest.map((r) => r.id), next: "Run `aztec-x402 withdraw finish` again for the rest." } : {}) };
}

