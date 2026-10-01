/**
 * `fund`: serve a local page where the user signs an L1 deposit to the agent,
 * then claim it on Aztec. Blocks until the deposit is claimed (or fails), so
 * agents should run it in the background and show the user the page URL
 * from the progress output.
 *
 * `fund claim`: finish deposits whose page or process went away.
 */
import { spawn } from "child_process";
import { generateClaimSecret } from "@aztec/aztec.js/ethereum";
import { loadAccountKeys } from "../aztec/keystore.js";
import { openSession, type Session } from "../aztec/session.js";
import type { ResolvedContext } from "../config.js";
import { CliError, UsageError } from "../errors.js";
import { progress } from "../output.js";
import { toHex, type BridgeAdapter } from "../fund/bridge.js";
import { publicView, readDeposits, saveDeposit, type DepositRecord } from "../fund/deposits.js";
import { FeeJuiceBridge } from "../fund/fee-juice.js";
import { completeDeposit, type Phase } from "../fund/process.js";
import { startFundServer } from "../fund/server.js";

/** How long `fund` waits for the user before giving up (the deposit stays resumable). */
const FUND_TIMEOUT_MS = 60 * 60_000;

async function bridgeFor(ctx: ResolvedContext): Promise<BridgeAdapter> {
  // One live route on v5 testnet; stablecoin portals become further adapters.
  return FeeJuiceBridge.create(ctx.network);
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

export async function fund(
  ctx: ResolvedContext,
  opts: { amount?: string; port?: number; host?: string; open: boolean },
) {
  const keys = loadAccountKeys(ctx.dataDir);
  if (!keys) throw new UsageError("No agent wallet. Run `aztec-x402 wallet create` first.", "no_wallet");

  const bridge = await bridgeFor(ctx);
  const description = await bridge.describe();
  const amountText = opts.amount ?? description.defaultAmount;
  const amount = bridge.parseAmount(amountText);
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
  };
  saveDeposit(ctx.dataDir, record);

  // Sync the wallet while the user is busy signing.
  const sessionPromise = openSession(ctx.network, ctx.dataDir);
  sessionPromise.catch(() => {});

  let phase: Phase | "signing" = "signing";
  let error: string | undefined;
  let l2Balance: string | undefined;
  let resolveDone: (r: DepositRecord) => void = () => {};
  let rejectDone: (e: unknown) => void = () => {};
  const done = new Promise<DepositRecord>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const server = await startFundServer(
    {
      async state() {
        return {
          network: ctx.network.name,
          l1ChainId: ctx.network.l1ChainId,
          l1ChainName: ctx.network.l1ChainName,
          l1ExplorerUrl: ctx.network.l1ExplorerUrl,
          agent: keys.address,
          amount: bridge.formatAmount(BigInt(record.amount)),
          bridge: description,
          phase,
          deposit: publicView(record),
          l2Balance,
          error,
        };
      },
      async prepare(owner) {
        if (phase !== "signing") throw new Error("Deposit already submitted");
        return { chainId: ctx.network.l1ChainId, txs: await bridge.prepare(toHex(owner), record) };
      },
      async submitted({ l1TxHash, owner }) {
        if (phase !== "signing") return { accepted: false, reason: "already submitted" };
        record = { ...record, l1TxHash, l1From: owner };
        saveDeposit(ctx.dataDir, record);
        phase = "waiting_l1";
        progress(`User sent L1 deposit ${l1TxHash}.`);
        void (async () => {
          const session = await sessionPromise;
          record = await completeDeposit(record, bridge, session, ctx.dataDir, (p) => (phase = p));
          l2Balance = `${bridge.formatAmount(await bridge.l2Balance(session))} ${description.l1Token.symbol}`;
          resolveDone(record);
        })().catch((e: unknown) => {
          error = e instanceof Error ? e.message : String(e);
          phase = "failed";
          rejectDone(e);
        });
        return { accepted: true };
      },
    },
    { host: opts.host, port: opts.port },
  );

  progress(`Funding page: ${server.url}`);
  progress(`Ask the user to open it, connect a ${ctx.network.l1ChainName} wallet, and sign. Waiting...`);
  if (opts.open) openBrowser(server.url);

  const timeout = setTimeout(
    () => rejectDone(new CliError("Timed out waiting for the deposit; nothing was claimed", "fund_timeout")),
    FUND_TIMEOUT_MS,
  );
  try {
    const final = await done;
    // Let the page pick up the final state before the server goes away.
    await new Promise((r) => setTimeout(r, 6000));
    return {
      network: ctx.network.name,
      agent: keys.address,
      bridge: description.id,
      amount: bridge.formatAmount(BigInt(final.amount)),
      l1TxHash: final.l1TxHash,
      claimTxHash: final.claimTxHash,
      l2Balance,
    };
  } finally {
    clearTimeout(timeout);
    await server.close();
  }
}

export async function fundClaim(ctx: ResolvedContext) {
  const pending = readDeposits(ctx.dataDir).filter((d) => d.status !== "claimed" && d.status !== "failed");
  const resumable = pending.filter((d) => d.l1TxHash);
  if (!resumable.length) {
    return { claimed: [], pending: pending.map(publicView), note: "Nothing to claim." };
  }
  const bridge = await bridgeFor(ctx);
  progress("Syncing private state...");
  const session: Session = await openSession(ctx.network, ctx.dataDir);
  const claimed = [];
  const failed = [];
  for (const deposit of resumable) {
    try {
      const result = await completeDeposit(deposit, bridge, session, ctx.dataDir);
      claimed.push(publicView(result));
    } catch (e) {
      failed.push({ ...publicView(deposit), error: e instanceof Error ? e.message : String(e) });
    }
  }
  return {
    claimed,
    failed,
    unsigned: pending.filter((d) => !d.l1TxHash).length,
  };
}
