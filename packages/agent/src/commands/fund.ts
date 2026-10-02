/**
 * `fund`: let the user deposit from their L1 wallet to the agent, then claim
 * it on Aztec.
 *
 * Two ways to give the user the funding page (the skill's assets/fund.html):
 * - local (default): the CLI serves it on 127.0.0.1 — for a browser on the
 *   agent's machine.
 * - hosted (`--hosted`): a link to the hosted copy with the funding plan in
 *   the URL fragment — for agents the user's browser cannot reach.
 *
 * Either way the CLI finds the deposit by watching L1 logs, so the page never
 * has to report back. With `--no-wait` (hosted only) the command prints the
 * link and exits; `fund claim` finishes the deposit later.
 */
import { spawn } from "child_process";
import { generateClaimSecret } from "@aztec/aztec.js/ethereum";
import { loadAccountKeys } from "../aztec/keystore.js";
import { openSession, type Session } from "../aztec/session.js";
import { fundPageUrl, type ResolvedContext } from "../config.js";
import { CliError, UsageError, messageOf } from "../errors.js";
import { progress } from "../output.js";
import { toHex, type BridgeAdapter, type BridgeDescription, type FundingPlan, type Hex } from "../fund/bridge.js";
import { publicView, readDeposits, saveDeposit, type DepositRecord } from "../fund/deposits.js";
import { FeeJuiceBridge } from "../fund/fee-juice.js";
import { completeDeposit, type Phase } from "../fund/process.js";
import { startFundServer } from "../fund/server.js";

/** How long `fund` waits for the user before giving up (the deposit stays resumable). */
const FUND_TIMEOUT_MS = 60 * 60_000;
const L1_POLL_MS = 12_000;

async function bridgeFor(ctx: ResolvedContext): Promise<BridgeAdapter> {
  // One live route on v5 testnet; stablecoin portals become further adapters.
  return FeeJuiceBridge.create(ctx.network);
}

export function buildPlan(
  ctx: ResolvedContext,
  bridge: BridgeAdapter,
  description: BridgeDescription,
  record: DepositRecord,
): FundingPlan {
  return {
    v: 1,
    network: ctx.network.name,
    l1ChainId: ctx.network.l1ChainId,
    l1ChainName: ctx.network.l1ChainName,
    l1ExplorerUrl: ctx.network.l1ExplorerUrl,
    agent: record.recipient,
    amount: bridge.formatAmount(BigInt(record.amount)),
    token: description.l1Token,
    portal: description.portal,
    title: description.title,
    result: description.result,
    privacy: description.privacy,
    steps: bridge.steps(record),
  };
}

export function encodePlan(plan: FundingPlan): string {
  return Buffer.from(JSON.stringify(plan)).toString("base64url");
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No browser on this machine; the URL is printed for the user.
  }
}

/** Resolve once the deposit tx is known: reported by the local page, or found on L1. */
async function waitForDepositTx(
  bridge: BridgeAdapter,
  getRecord: () => DepositRecord,
  deadline: number,
): Promise<Hex> {
  const fromBlock = BigInt(getRecord().l1FromBlock ?? "0");
  for (;;) {
    const reported = getRecord().l1TxHash;
    if (reported) return toHex(reported);
    try {
      const found = await bridge.findDeposit(getRecord(), fromBlock);
      if (found) return found;
    } catch (error) {
      progress(`L1 search failed (will retry): ${messageOf(error)}`);
    }
    if (Date.now() > deadline) {
      throw new CliError(
        "No deposit seen on L1 within 60 minutes. If the user sent it later, run `aztec-x402 fund claim`.",
        "fund_timeout",
      );
    }
    await new Promise((r) => setTimeout(r, L1_POLL_MS));
  }
}

export async function fund(
  ctx: ResolvedContext,
  opts: { amount?: string; port?: number; host?: string; open: boolean; hosted: boolean; wait: boolean },
) {
  const keys = loadAccountKeys(ctx.dataDir);
  if (!keys) throw new UsageError("No agent wallet. Run `aztec-x402 wallet create` first.", "no_wallet");
  if (!opts.wait && !opts.hosted) throw new UsageError("--no-wait needs --hosted: the local page lives only while `fund` runs");

  const bridge = await bridgeFor(ctx);
  const description = await bridge.describe();
  const amount = bridge.parseAmount(opts.amount ?? description.defaultAmount);
  if (amount <= 0n) throw new UsageError("--amount must be positive");

  const [secret, secretHash] = await generateClaimSecret();
  let record: DepositRecord = {
    id: crypto.randomUUID(),
    bridge: description.id,
    recipient: keys.address,
    amount: amount.toString(),
    secret: secret.toString(),
    secretHash: secretHash.toString(),
    status: "awaiting_l1",
    createdAt: new Date().toISOString(),
    // A few blocks of slack in case the user is quicker than our RPC.
    l1FromBlock: ((await bridge.l1BlockNumber()) - 5n).toString(),
    mode: opts.hosted ? "hosted" : "local",
  };
  saveDeposit(ctx.dataDir, record);
  const plan = buildPlan(ctx, bridge, description, record);

  let phase: Phase | "signing" = "signing";
  let error: string | undefined;
  let l2Balance: string | undefined;
  const balanceText = async (session: Session) =>
    `${bridge.formatAmount(await bridge.l2Balance(session))} ${description.l1Token.symbol}`;

  let hostedUrl: string | undefined;
  let server: Awaited<ReturnType<typeof startFundServer>> | undefined;
  if (opts.hosted) {
    hostedUrl = `${fundPageUrl()}#${encodePlan(plan)}`;
    progress(`Funding page: ${hostedUrl}`);
    if (!opts.wait) {
      return {
        network: ctx.network.name,
        agent: keys.address,
        bridge: description.id,
        amount: plan.amount,
        depositId: record.id,
        url: hostedUrl,
        next: "After the user deposits, run `aztec-x402 fund claim` to claim it on Aztec.",
      };
    }
  } else {
    server = await startFundServer(
      {
        async state() {
          return { plan, phase, deposit: publicView(record), l2Balance, error };
        },
        async submitted({ l1TxHash, owner }) {
          if (record.l1TxHash) return { accepted: false, reason: "already submitted" };
          record = { ...record, l1TxHash, l1From: owner };
          saveDeposit(ctx.dataDir, record);
          phase = "waiting_l1";
          progress(`User sent L1 deposit ${l1TxHash}.`);
          return { accepted: true };
        },
      },
      { host: opts.host, port: opts.port },
    );
    progress(`Funding page: ${server.url}`);
    for (const url of server.networkUrls) progress(`  from another machine: ${url}`);
    if (server.networkUrls.length) {
      progress("  Browser wallets load only on https and localhost pages; over a plain IP use port forwarding or `fund --hosted`.");
    }
    if (opts.open) openBrowser(server.url);
  }
  progress(`Ask the user to open it, connect a ${ctx.network.l1ChainName} wallet, and sign. Waiting for the deposit...`);

  // Sync the wallet while the user is busy signing.
  const sessionPromise = openSession(ctx.network, ctx.dataDir);
  sessionPromise.catch(() => {});

  try {
    const l1TxHash = await waitForDepositTx(bridge, () => record, Date.now() + FUND_TIMEOUT_MS);
    if (!record.l1TxHash) {
      record = { ...record, l1TxHash };
      saveDeposit(ctx.dataDir, record);
      progress(`Found the L1 deposit ${l1TxHash}.`);
    }
    phase = "waiting_l1";
    // "done" is published only once the balance is known: the page stops polling at "done".
    record = await completeDeposit(record, bridge, () => sessionPromise, ctx.dataDir, (p) => {
      if (p !== "done") phase = p;
    });
    l2Balance = await balanceText(await sessionPromise);
    phase = "done";
    // Let a local page pick up the final state before the server goes away.
    if (server) await new Promise((r) => setTimeout(r, 6000));
    return {
      network: ctx.network.name,
      agent: keys.address,
      bridge: description.id,
      amount: bridge.formatAmount(BigInt(record.amount)),
      l1TxHash: record.l1TxHash,
      claimTxHash: record.claimTxHash,
      l2Balance,
    };
  } catch (e) {
    error = messageOf(e);
    phase = "failed";
    if (server) await new Promise((r) => setTimeout(r, 6000));
    throw e;
  } finally {
    await server?.close();
  }
}

export async function fundClaim(ctx: ResolvedContext) {
  const pending = readDeposits(ctx.dataDir).filter((d) => d.status !== "claimed" && d.status !== "failed");
  if (!pending.length) return { claimed: [], failed: [], unsigned: 0, note: "Nothing to claim." };

  const bridge = await bridgeFor(ctx);
  // Hosted-page deposits never report back: look for them on L1 first.
  for (const deposit of pending.filter((d) => !d.l1TxHash && d.l1FromBlock)) {
    const found = await bridge.findDeposit(deposit, BigInt(deposit.l1FromBlock ?? "0"));
    if (found) {
      deposit.l1TxHash = found;
      saveDeposit(ctx.dataDir, deposit);
    }
  }
  const resumable = pending.filter((d) => d.l1TxHash);
  if (!resumable.length) {
    return { claimed: [], failed: [], unsigned: pending.length, note: "No deposit found on L1 yet." };
  }

  let session: Promise<Session> | undefined;
  const getSession = () => {
    if (!session) {
      progress("Syncing private state...");
      session = openSession(ctx.network, ctx.dataDir);
    }
    return session;
  };
  const claimed = [];
  const failed = [];
  for (const deposit of resumable) {
    try {
      // Resumed deposits were sent long ago: a receipt that is not there now will not be.
      claimed.push(
        publicView(await completeDeposit(deposit, bridge, getSession, ctx.dataDir, undefined, { l1TimeoutMs: 30_000 })),
      );
    } catch (e) {
      failed.push({ ...publicView(deposit), error: messageOf(e) });
    }
  }
  return { claimed, failed, unsigned: pending.length - resumable.length };
}
