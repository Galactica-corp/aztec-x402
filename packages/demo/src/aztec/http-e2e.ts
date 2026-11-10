/**
 * The whole path over HTTP on a local network: the demo server (its own
 * process, persistent PXE, SQLite store) and the agent CLI (its own process),
 * paying the inference-money USDC under a reference and from Ethereum, with
 * the failures the handover asks for staged for real:
 *
 * - a retried request with the same proof is served once;
 * - the agent dies right after paying (proof stored): `pay --resume` delivers;
 * - the server dies between storing a proof and taking it in: on restart it
 *   takes the proof in, and `pay --resume` is served;
 * - a split deposit is paid through the funding page's steps (run against
 *   anvil's unlocked accounts, as a browser wallet would), served, and its
 *   claim survives a server restart; the agent then collects the change.
 *
 * Prerequisites: a local network and `bun run setup:sandbox:inference`.
 * Usage: bun run packages/demo/src/aztec/http-e2e.ts
 */
import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { accountFromKeys, createNodeClient, loadAccountKeys } from "@galactica-net/x402-agent/aztec";
import { l2UsdcBalance, parseManifest, registerBridgeContracts, registerSponsor } from "@galactica-net/inference-money-core";
import { BRIDGE_EVM_ARTIFACTS, l1Signer, startBlockHeartbeat, writeEvm } from "@galactica-net/inference-money-core/deploy";
import { sqliteStateStore } from "@galactica-net/x402-middleware";
import { mnemonicToAccount } from "viem/accounts";
import { createPXEWallet } from "./pxe-wallet.js";
import { ANVIL_MNEMONIC, depositAndClaim } from "./setup-inference.js";
import { loadAccount, loadKeys, setupSponsoredPayment } from "./wallet-manager.js";
import { DATA_DIR } from "./data-dir.js";

const __dirname = dirname(new URL(import.meta.url).pathname);
const REPO = join(__dirname, "../../../..");
const config = JSON.parse(readFileSync(join(DATA_DIR, "deploy.json"), "utf-8"));
if (!config.manifestPath || !config.l1RpcUrl) throw new Error("Run `bun run setup:sandbox:inference` first.");
const m = parseManifest(JSON.parse(readFileSync(config.manifestPath, "utf-8")));
const PORT = 4499;
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * A proxy between the agent and the server that loses a payment on the way:
 * "request" drops a request that carries a payment before the server sees it,
 * "response" forwards it and drops the server's 2xx answer.
 */
let lose: "nothing" | "request" | "response" = "nothing";
const proxy = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const paying = req.headers.has("PAYMENT-SIGNATURE");
    if (paying && lose === "request") return new Response("bad gateway", { status: 502 });
    const headers = new Headers(req.headers);
    headers.delete("host");
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    const answer = await fetch(`${BASE}${url.pathname}${url.search}`, { method: req.method, headers, body });
    if (paying && lose === "response" && answer.ok) return new Response("bad gateway", { status: 502 });
    return answer;
  },
});
const VIA_PROXY = `http://127.0.0.1:${proxy.port}`;
/** The agent funds from, and pays splits from, this anvil account: its first claim binds the agent to it. */
const AGENT_L1_INDEX = 7;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------
// The agent CLI, in its own home.

const agentHome = join(DATA_DIR, "http-e2e-agent");
rmSync(agentHome, { recursive: true, force: true });
mkdirSync(agentHome, { recursive: true });
writeFileSync(
  join(agentHome, "config.json"),
  JSON.stringify({
    network: "local",
    tokens: { local: [{ symbol: "USDC", name: "USDC (local bridge)", address: config.tokenAddress, decimals: 6 }] },
  }),
);
const agentEnv = {
  ...process.env,
  AZTEC_X402_HOME: agentHome,
  AZTEC_X402_NODE_URL: config.nodeUrl,
  AZTEC_X402_L1_RPC_URL: config.l1RpcUrl,
  AZTEC_X402_BRIDGE_MANIFEST: config.manifestPath,
  // The hosted link is decoded here, never opened.
  AZTEC_X402_FUND_PAGE_URL: "http://fund.invalid/fund.html",
};

interface CliRun {
  code: number | null;
  out: Record<string, unknown>;
  stderr: string;
}

function agent(args: string[], opts: { killWhen?: RegExp } = {}): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", join(REPO, "packages/agent/src/cli.ts"), ...args, "--network", "local"], { env: agentEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => {
      stderr += d;
      if (opts.killWhen?.test(stderr)) child.kill("SIGKILL");
    });
    child.on("close", (code) => {
      let out: Record<string, unknown> = {};
      try {
        out = JSON.parse(stdout);
      } catch {
        // killed before printing
      }
      resolve({ code, out, stderr });
    });
  });
}

const get = (o: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((v, k) => (typeof v === "object" && v !== null ? Reflect.get(v, k) : undefined), o);

// ---------------------------------------------------------------------------
// The server, in its own process.

let server: ChildProcess | undefined;
let serverLog = "";

async function startServer(env: Record<string, string> = {}): Promise<void> {
  serverLog = "";
  server = spawn("bun", ["run", join(REPO, "packages/demo/src/aztec/real-server.ts")], {
    env: { ...process.env, DATA_DIR, PORT: String(PORT), USE_SPONSORED_FPC: "true", ...env },
  });
  server.stdout?.on("data", (d) => (serverLog += d));
  server.stderr?.on("data", (d) => (serverLog += d));
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      // not up yet
    }
    if (server.exitCode !== null) throw new Error(`server exited:\n${serverLog}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server did not come up:\n${serverLog}`);
}

async function stopServer(): Promise<number | null> {
  const s = server;
  if (!s) return null;
  if (s.exitCode === null) {
    s.kill("SIGTERM");
    await new Promise((r) => s.once("close", r));
  }
  server = undefined;
  return s.exitCode;
}

const waitExit = (s: ChildProcess) => new Promise<number | null>((r) => (s.exitCode !== null ? r(s.exitCode) : s.once("close", () => r(s.exitCode))));

// ---------------------------------------------------------------------------

const node = createNodeClient(config.nodeUrl);
const wallet = await createPXEWallet(node, { ephemeral: true, pxe: { proverEnabled: false } });
await registerSponsor(wallet, m);
const stopHeartbeat = await startBlockHeartbeat(wallet, m);

try {
  // The server's state starts fresh: a persistent PXE, a SQLite store and a reference secret under DATA_DIR.
  for (const f of ["pxe", "server-pxe", "x402-state.sqlite", "x402-state.sqlite-wal", "x402-state.sqlite-shm", "x402-ref-secret", "crash-marker"]) {
    rmSync(join(DATA_DIR, f), { recursive: true, force: true });
  }

  // The agent's wallet, funded with 2 USDC over the bridge from its own L1 key.
  const created = await agent(["wallet", "create"]);
  check("the agent creates its wallet", created.code === 0, JSON.stringify(created.out).slice(0, 200));
  const keys = loadAccountKeys(join(agentHome, "local"));
  if (!keys) throw new Error("no agent keys");
  const agentAccount = await accountFromKeys(wallet, keys);
  await setupSponsoredPayment(wallet);
  await registerBridgeContracts(wallet, m);
  const agentL1 = l1Signer(config.l1RpcUrl, m.l1.chainId, mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: AGENT_L1_INDEX }));
  await writeEvm(agentL1, "MockUsdc mint", m.l1.usdc, BRIDGE_EVM_ARTIFACTS.mockUsdc.abi, "mint", [agentL1.account.address, 50_000_000n]);
  await depositAndClaim(
    { node, l1RpcUrl: config.l1RpcUrl, wallet, merchant: AztecAddress.fromStringUnsafe(config.bobAddress), payer: agentAccount.address, amount: 2_000_000n, log: console.log },
    agentL1,
    m,
    2_000,
  );
  const balanceOf = (who: AztecAddress) => l2UsdcBalance(wallet, m, who, "private");
  check("the agent holds 2 USDC on Aztec", (await balanceOf(agentAccount.address)) === 2_000_000n);

  await startServer({ X402_CLAIM_POLL_MS: "5000" });
  const health = await (await fetch(`${BASE}/health`)).json();
  check("the server offers ref, split and commitment", JSON.stringify(health.paymentModes) === JSON.stringify(["ref", "split", "commitment"]), JSON.stringify(health.paymentModes));

  // 1. A ref payment, served; the same proof again is not served twice.
  const started = Date.now();
  const paid = await agent(["pay", `${BASE}/api/weather/1`, "--max-amount", "0.02"]);
  check("the agent pays under a reference and is served", paid.code === 0 && get(paid.out, "payment", "mode") === "ref", `${Math.round((Date.now() - started) / 1000)}s ${paid.stderr.slice(-300)}`);
  const firstId = String(get(paid.out, "payment", "id"));
  const stored = JSON.parse(readFileSync(join(agentHome, "local", "proofs", `${firstId}.json`), "utf-8"));
  const replay = await fetch(`${BASE}/api/weather/1`, {
    headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(stored.payload)).toString("base64") },
  });
  check("a retried request with the same proof is not served twice", replay.status === 402);

  // 2. The payment never reaches the server (the proof is stored first): resume delivers it.
  lose = "request";
  const lostRequest = await agent(["pay", `${VIA_PROXY}/api/weather/2`, "--max-amount", "0.02"]);
  lose = "nothing";
  const proofs = readdirSync(join(agentHome, "local", "proofs")).filter((f) => f.endsWith(".json"));
  const pendingIds = proofs.map((f) => JSON.parse(readFileSync(join(agentHome, "local", "proofs", f), "utf-8"))).filter((p) => !p.acknowledgedAt);
  check(
    "a payment lost before the server leaves its proof on disk, with resume",
    lostRequest.code !== 0 && get(lostRequest.out, "error", "code") === "not_delivered" && pendingIds.length === 1,
    `${pendingIds.length} pending`,
  );
  const resumed = await agent(["pay", "--resume", String(pendingIds[0]?.id)]);
  check("pay --resume delivers it and is served", resumed.code === 0, resumed.stderr.slice(-300));

  // 2b. The server serves, and its response is lost: a reference is served once, so it is not delivered again.
  lose = "response";
  const lostResponse = await agent(["pay", `${VIA_PROXY}/api/weather/2b`, "--max-amount", "0.02"]);
  lose = "nothing";
  const lostId = String(get(lostResponse.out, "error", "payment", "id"));
  const refused = await agent(["pay", "--resume", lostId]);
  check(
    "a response lost after serving ends as response_lost, not served twice",
    get(refused.out, "error", "code") === "response_lost" && get(refused.out, "error", "resume") === undefined,
    JSON.stringify(get(refused.out, "error", "code")),
  );

  // 3. The server dies after storing a proof, before taking it in; on restart it takes it in.
  await stopServer();
  const marker = join(DATA_DIR, "crash-marker");
  await startServer({ X402_TEST_CRASH_BEFORE_TAKE_IN: marker });
  const crashing = server;
  const unserved = await agent(["pay", `${BASE}/api/weather/3`, "--max-amount", "0.02"]);
  const exitCode = crashing ? await waitExit(crashing) : null;
  check("the server exited between storing and taking in the proof", exitCode === 75 && existsSync(marker), `exit ${exitCode}`);
  check("the agent kept the payment for later", get(unserved.out, "error", "code") === "not_delivered");
  const store = sqliteStateStore(join(DATA_DIR, "x402-state.sqlite"));
  check("the server's store holds the proof, not taken in", (await store.proofsNotTakenIn(0)).length === 1);
  store.close?.();
  server = undefined;
  await startServer({ X402_CLAIM_POLL_MS: "3600000" });
  check("on restart the server took the stored proof in", /1 taken in/.test(serverLog), serverLog.split("\n").filter((l) => l.includes("Replayed")).join(" "));
  const afterCrash = await agent(["pay", "--resume", String(get(unserved.out, "error", "payment", "id"))]);
  check("and the resumed request is served", afterCrash.code === 0, afterCrash.stderr.slice(-300));

  // 4. Split: the page's steps, signed by the agent's L1 account through anvil's JSON-RPC wallet.
  // The merchant's keys in this wallet see its notes delivered on chain (the split claim's), not those the server took in offchain.
  await loadAccount(wallet, loadKeys(join(DATA_DIR, "keys.json")), "bob");
  const merchantBefore = await balanceOf(AztecAddress.fromStringUnsafe(config.bobAddress));
  const agentBefore = await balanceOf(agentAccount.address);
  const pending = await agent(["pay", `${BASE}/api/weather/4`, "--max-amount", "0.5", "--from-ethereum", "--hosted", "--no-wait"]);
  const link = String(get(pending.out, "link"));
  check("pay --from-ethereum returns a payment page link", link.includes("#"), pending.stderr.slice(-300));
  const plan = JSON.parse(Buffer.from(link.split("#")[1] ?? "", "base64url").toString());
  check("the page asks for a round deposit, approval, permit and deposit", plan.amount === "1" && plan.steps.map((s: { id: string }) => s.id).join() === "approve,permit,deposit", `${plan.amount}`);
  await runPlan(plan, agentL1.account.address);
  const splitId = String(get(pending.out, "id"));
  const splitPaid = await agent(["pay", "--resume", splitId]);
  check("the agent finds the deposit and the merchant serves it", splitPaid.code === 0 && get(splitPaid.out, "payment", "mode") === "split", splitPaid.stderr.slice(-400));

  // The claim job polls hourly in this run: the claim is still pending when the server stops.
  await stopServer();
  const claims = sqliteStateStore(join(DATA_DIR, "x402-state.sqlite"));
  check("the served split deposit waits as a pending claim", (await claims.splitClaims("pending")).length === 1);
  claims.close?.();
  await startServer({ X402_CLAIM_POLL_MS: "5000" });
  let claimed = false;
  for (let i = 0; i < 90 && !claimed; i++) {
    claimed = /Claimed the split deposit/.test(serverLog);
    if (!claimed) await new Promise((r) => setTimeout(r, 2000));
  }
  check("after a restart, the claim job claims it", claimed);
  const merchantGot = (await balanceOf(AztecAddress.fromStringUnsafe(config.bobAddress))) - merchantBefore;
  check("the merchant received the price", merchantGot === 10_000n, `${merchantGot}`);

  const change = await agent(["fund", "change", "--allow-bind"]);
  check("the agent collects the change", change.code === 0 && get(change.out, "collected", "length") === 1, JSON.stringify(change.out).slice(0, 300));
  const agentDelta = (await balanceOf(agentAccount.address)) - agentBefore;
  check("its Aztec balance rose by deposit minus price", agentDelta === 1_000_000n - 10_000n, `${agentDelta}`);
} finally {
  await stopServer();
  await stopHeartbeat();
}

/** What the funding page does with a browser wallet: skip what is done, sign the permit, send the rest. */
async function runPlan(plan: { steps: Array<{ id: string; kind?: string; to: string; data: string; typedData?: unknown; skipIf?: { to: string; data: string; gte: string } }> }, owner: string) {
  const rpc = async (method: string, params: unknown[]) => {
    const res = await fetch(config.l1RpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const json = await res.json();
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    return json.result;
  };
  let signature = "";
  const fill = (d: string) => d.split("{owner}").join(owner.slice(2).toLowerCase().padStart(64, "0")).split("{signature}").join(signature.slice(2));
  for (const step of plan.steps) {
    if (step.kind === "sign") {
      signature = await rpc("eth_signTypedData_v4", [owner, JSON.stringify(step.typedData)]);
      continue;
    }
    if (step.skipIf) {
      const result = await rpc("eth_call", [{ to: step.skipIf.to, data: fill(step.skipIf.data) }, "latest"]);
      if (BigInt(result === "0x" ? 0 : result) >= BigInt(step.skipIf.gte)) continue;
    }
    const hash = await rpc("eth_sendTransaction", [{ from: owner, to: step.to, data: fill(step.data) }]);
    for (;;) {
      const receipt = await rpc("eth_getTransactionReceipt", [hash]);
      if (receipt) {
        if (receipt.status !== "0x1") throw new Error(`step ${step.id} reverted`);
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
