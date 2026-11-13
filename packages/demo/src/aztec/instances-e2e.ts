/**
 * End-to-end check of several merchant instances on one payment store, with
 * the inference-money USDC in deploy.json (local network or testnet):
 *
 * 1. Two `createMerchant` instances, each with its own data folder, share a
 *    SQLite store: one holds the jobs' lease, the other does not.
 * 2. A ref payment is taken in by the instance without the lease, into its
 *    own wallet, as its middleware would.
 * 3. The leader's consolidation takes that payment in from the stored proof
 *    and merges it: the leader's wallet holds it, and so does the other's
 *    once the merged note is on chain.
 * 4. When the leader stops, the other instance takes the jobs over.
 *
 * Usage: bun run packages/demo/src/aztec/instances-e2e.ts (after the inference setup)
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createMerchant, createNodeClient, TokenRegistry, type CreateMerchantOptions } from "@galactica-net/x402-agent/aztec";
import { parseManifest } from "@galactica-net/inference-money-core";
import { derivePaymentRef, sqliteStateStore } from "@galactica-net/x402-middleware";
import { RealClientAztecSigner } from "./client-signer.js";
import { merchantNetwork, shouldEnableProver } from "./network-config.js";
import { loadAccount, loadKeys, merchantKeys, openDemoWallet, setupSponsoredPayment } from "./wallet-manager.js";
import { DATA_DIR } from "./data-dir.js";

const AMOUNT = 10_000n;
const config = JSON.parse(readFileSync(join(DATA_DIR, "deploy.json"), "utf-8"));
const TOKEN: string = config.tokenAddress;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const root = join(DATA_DIR, "instances-e2e");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const keys = loadKeys(join(DATA_DIR, "keys.json"));
const shared = join(root, "payments.sqlite");

const base: Omit<CreateMerchantOptions, "dataDir"> = {
  network: merchantNetwork(config.network, config.nodeUrl),
  keys: await merchantKeys(keys, "bob"),
  token: TOKEN,
  manifest: config.manifestPath ? parseManifest(JSON.parse(readFileSync(config.manifestPath, "utf-8"))) : undefined,
  leaseMs: 3_000,
  handleSignals: false,
};
const a = await createMerchant({ ...base, dataDir: join(root, "a"), store: sqliteStateStore(shared), log: (m) => console.log(`      [a] ${m}`) });
const b = await createMerchant({ ...base, dataDir: join(root, "b"), store: sqliteStateStore(shared), log: (m) => console.log(`      [b] ${m}`) });

try {
  check("one of two instances on a shared store runs the jobs", a.jobs.isLeader && !b.jobs.isLeader, `a ${a.jobs.isLeader}, b ${b.jobs.isLeader}`);
  // a consolidates at start (nothing recorded yet in the new store): let that finish first.
  for (let i = 0; i < 120 && (await a.status()).consolidatedAt === undefined; i++) await sleep(1_000);

  // The payer pays b under a reference; b takes it in as its middleware does: store the proof, then receive it.
  const node = createNodeClient(config.nodeUrl);
  const { wallet, paymentGate } = await openDemoWallet(node, shouldEnableProver(config.network), TOKEN);
  const payer = await loadAccount(wallet, keys, "alice");
  const fee = { paymentMethod: await setupSponsoredPayment(wallet) };
  const client = new RealClientAztecSigner(payer, new TokenRegistry({ node, wallet, account: payer.address, fee, paymentGate }));
  const nonce = crypto.randomUUID();
  const paymentRef = derivePaymentRef(randomBytes(32), { nonce, route: "/api/infer", network: config.network, asset: TOKEN, payTo: b.address.toString(), price: AMOUNT.toString() });
  const proof = await client.payPrivate(TOKEN, b.address.toString(), AMOUNT, paymentRef);
  const leaderBefore = await a.token.privateBalance();
  await b.store.saveProof({ paymentRef, nonce, mode: "ref", asset: TOKEN, payload: JSON.stringify({ mode: "ref", ...proof }), price: AMOUNT.toString(), receivedAt: Date.now(), takenIn: false });
  const received = await b.signer.receiveRefPayment(TOKEN, proof, { paymentRef, price: AMOUNT });
  if (received.isValid) await b.store.markTakenIn(paymentRef);
  check("the instance without the lease takes the payment in", received.isValid, received.error);
  check("the leader's wallet does not see it yet", (await a.token.privateBalance()) === leaderBefore);
  check("both report it as waiting for consolidation", (await a.status()).unconsolidated.count === 1 && (await b.status()).unconsolidated.count === 1);

  // The leader consolidates: its catch-up takes the stored proof into its own wallet first.
  const ran = await a.jobs.consolidateIfDue();
  const leaderGot = (await a.token.privateBalance()) - leaderBefore;
  check("the leader's consolidation takes the other instance's payment in and merges it", ran && leaderGot === AMOUNT, `ran ${ran}, rose by ${leaderGot}`);
  check("nothing waits for consolidation any more", (await b.status()).unconsolidated.count === 0);
  let seen = false;
  for (let i = 0; i < 30 && !seen; i++) {
    seen = (await b.token.privateBalance()) === (await a.token.privateBalance());
    if (!seen) await sleep(2_000);
  }
  check("the other instance's wallet sees the same merged balance", seen);

  await a.stop();
  for (let i = 0; i < 50 && !b.jobs.isLeader; i++) await sleep(200);
  check("when the leader stops, the other instance takes the jobs over", b.jobs.isLeader && (await b.status()).leader);
} finally {
  await a.stop();
  await b.stop();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
