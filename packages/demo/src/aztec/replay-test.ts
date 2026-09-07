/**
 * Replay attack + load test — verifies that the same payment header
 * cannot be used twice, including under concurrent replay.
 *
 * One real Aztec payment is created, then stampeded onto many unpaid
 * resources. Follow-up floods and a few header mutations must all fail.
 */
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { TokenContract } from "@aztec-foundation/aztec-standards/dist/src/artifacts/Token.js";
import { createPXEWallet } from "./pxe-wallet.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { ExactAztecClientScheme } from "@galactica-net/x402-mechanism/exact/client";
import { RealClientAztecSigner } from "./client-signer.js";
import { loadKeys, loadAccount, setupSponsoredPayment } from "./wallet-manager.js";

const SERVER_URL = process.env.SERVER_URL ?? "https://aztec-x402.unfazed.engineering";
const CONCURRENCY = Math.max(2, Number(process.env.REPLAY_CONCURRENCY ?? 100) || 100);
const __dirname = dirname(new URL(import.meta.url).pathname);
const DATA_DIR = process.env.DATA_DIR ?? __dirname;
const CONFIG_PATH = join(DATA_DIR, "deploy.json");
const KEYS_PATH = join(DATA_DIR, "keys.json");
const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

// The middleware serves an already-paid resource for free, so every replay
// must target a DIFFERENT, unpaid resource. Fresh ids per run keep a previous
// run's paid-resource cache out of the way.
const RUN_ID = crypto.randomUUID().slice(0, 8);
const PREP_PATH = `/api/weather/replay-prep-${RUN_ID}`;

const NODE_URL = config.nodeUrl;
const isRemoteNetwork = config.network !== "aztec:sandbox";

const node = createAztecNodeClient(NODE_URL);
const wallet = await createPXEWallet(node, {
  ephemeral: true,
  pxe: { proverEnabled: isRemoteNetwork },
});

const keys = loadKeys(KEYS_PATH);
const aliceAccount = await loadAccount(wallet, keys, "alice");
const tokenAddress = AztecAddress.fromStringUnsafe(config.tokenAddress);
const tokenInstance = await node.getContract(tokenAddress);
if (tokenInstance) {
  await wallet.registerContract(tokenInstance, TokenContract.artifact);
}
const token = await TokenContract.at(tokenAddress, wallet);

// Fees are non-zero on public networks, and these accounts hold no fee juice,
// so route them through the Sponsored FPC exactly as the main client does.
const paymentMethod = isRemoteNetwork ? await setupSponsoredPayment(wallet) : undefined;
const feeOpts = paymentMethod ? { fee: { paymentMethod } } : undefined;
const clientSigner = new RealClientAztecSigner(aliceAccount, token, feeOpts);
const scheme = new ExactAztecClientScheme(clientSigner);

interface BurstResult {
  path: string;
  label?: string;
  status: number;
  error?: string;
}

interface BurstTally {
  ok: number;
  paymentRequired: number;
  other: number;
}

async function burst(
  targets: { path: string; header: string; label?: string }[],
): Promise<BurstResult[]> {
  return Promise.all(
    targets.map(async ({ path, header, label }) => {
      const resp = await fetch(SERVER_URL + path, {
        headers: { "PAYMENT-SIGNATURE": header },
      });
      let error: string | undefined;
      try {
        const body: unknown = await resp.json();
        if (body && typeof body === "object") {
          const errorValue = Reflect.get(body, "error");
          if (errorValue != null) error = String(errorValue);
        }
      } catch {
        // ignore non-JSON bodies
      }
      return { path, label, status: resp.status, error };
    }),
  );
}

function tally(results: BurstResult[]): BurstTally {
  const ok = results.filter((result) => result.status === 200).length;
  const paymentRequired = results.filter((result) => result.status === 402).length;
  return { ok, paymentRequired, other: results.length - ok - paymentRequired };
}

function printTally(title: string, results: BurstResult[]): BurstTally {
  const counts = tally(results);
  console.log(
    `  ${title}: ${counts.ok} x 200, ${counts.paymentRequired} x 402, ${counts.other} x other (n=${results.length})`,
  );
  for (const result of results) {
    const name = result.label ?? result.path;
    const reason = result.error ? ` (${result.error})` : "";
    console.log(`    ${name} -> ${result.status}${reason}`);
  }
  return counts;
}

function getRecord(value: unknown): object | undefined {
  if (value && typeof value === "object") return value;
  return undefined;
}

function getNested(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    const record = getRecord(current);
    if (!record) return undefined;
    current = Reflect.get(record, key);
  }
  return current;
}

function mutateHeaders(encoded: string): { label: string; header: string }[] {
  const json: unknown = JSON.parse(Buffer.from(encoded, "base64").toString());

  const flipped = structuredClone(json);
  const payload = getRecord(getNested(flipped, "payload"));
  const txHash = String(getNested(payload, "txHash") ?? "0x00");
  const hexIndex = txHash.startsWith("0x") ? 2 : 0;
  const flippedChar = txHash[hexIndex] === "0" ? "1" : "0";
  if (payload) {
    Reflect.set(
      payload,
      "txHash",
      txHash.slice(0, hexIndex) + flippedChar + txHash.slice(hexIndex + 1),
    );
  }

  const droppedNonce = structuredClone(json);
  const droppedExtra = getRecord(getNested(droppedNonce, "accepted", "extra"));
  if (droppedExtra) Reflect.deleteProperty(droppedExtra, "nonce");

  const replacedNonce = structuredClone(json);
  const replacedExtra = getRecord(getNested(replacedNonce, "accepted", "extra"));
  if (replacedExtra) Reflect.set(replacedExtra, "nonce", crypto.randomUUID());

  return [
    { label: "truncated-base64", header: encoded.slice(0, Math.max(8, encoded.length - 8)) },
    { label: "flipped-txHash", header: Buffer.from(JSON.stringify(flipped)).toString("base64") },
    { label: "dropped-nonce", header: Buffer.from(JSON.stringify(droppedNonce)).toString("base64") },
    { label: "replaced-nonce", header: Buffer.from(JSON.stringify(replacedNonce)).toString("base64") },
    { label: "empty-header", header: "" },
  ];
}

// Step 1: Get 402 + requirements
const initialResp = await fetch(SERVER_URL + PREP_PATH);
console.log("Step 1 — Initial response:", initialResp.status);

const payReqHeader = initialResp.headers.get("payment-required");
if (!payReqHeader) { console.error("No payment-required header"); process.exit(1); }

const paymentRequired = JSON.parse(Buffer.from(payReqHeader, "base64").toString());
let requirements = paymentRequired.accepts[0];

// Step 2: Prepare — hand the server our address so it can create a commitment.
// The payment flow is three-phase; without this the requirements carry only a
// nonce and createPaymentPayload has no commitment to complete.
const senderAddress = await scheme.getSenderAddress?.();
if (!senderAddress) {
  console.error("client scheme did not expose a sender address");
  process.exit(1);
}
const prepareData = Buffer.from(
  JSON.stringify({ nonce: requirements.extra?.nonce, senderAddress }),
).toString("base64");
const prepareResp = await fetch(SERVER_URL + PREP_PATH, {
  headers: { "X-402-PREPARE": prepareData },
});
const preparedHeader = prepareResp.headers.get("payment-required");
if (!preparedHeader) {
  console.error("prepare phase returned no payment-required header");
  process.exit(1);
}
const prepared = JSON.parse(Buffer.from(preparedHeader, "base64").toString());
requirements = prepared.accepts[0];
if (!requirements?.extra?.commitment) {
  console.error("prepare phase returned no commitment");
  process.exit(1);
}
console.log(`  Commitment: ${String(requirements.extra.commitment).slice(0, 20)}...`);

// Step 3: Create payment payload against the prepared requirements
const payloadResult = await scheme.createPaymentPayload(paymentRequired.x402Version, requirements);
const fullPayload = {
  x402Version: payloadResult.x402Version,
  accepted: requirements,
  payload: payloadResult.payload,
  extensions: payloadResult.extensions,
};
const encoded = Buffer.from(JSON.stringify(fullPayload)).toString("base64");

console.log(`\nConcurrency: ${CONCURRENCY}`);

// Step 4: Stampede — same header, N distinct unpaid paths. Exactly one 200.
console.log(`\nStep 4 — STAMPEDE (${CONCURRENCY} concurrent identical headers)...`);
const stampedeResults = await burst(
  Array.from({ length: CONCURRENCY }, (_, i) => ({
    path: `/api/weather/replay-${RUN_ID}-stampede-${i}`,
    header: encoded,
  })),
);
const stampedeTally = printTally("stampede", stampedeResults);

// Step 5: Follow-up flood — payment already consumed, still under load.
console.log(`\nStep 5 — FLOOD (${CONCURRENCY} concurrent replays on new unpaid paths)...`);
const floodResults = await burst(
  Array.from({ length: CONCURRENCY }, (_, i) => ({
    path: `/api/weather/replay-${RUN_ID}-flood-${i}`,
    header: encoded,
  })),
);
const floodTally = printTally("flood", floodResults);

// Step 6: Tiny in-script fuzz — mutated headers must not return 200.
console.log("\nStep 6 — FUZZ (mutated headers, concurrent)...");
const mutations = mutateHeaders(encoded);
const fuzzResults = await burst(
  mutations.map((mutation, i) => ({
    path: `/api/weather/replay-${RUN_ID}-fuzz-${i}`,
    header: mutation.header,
    label: mutation.label,
  })),
);
const fuzzTally = printTally("fuzz", fuzzResults);

const passed =
  stampedeTally.ok === 1 &&
  floodTally.ok === 0 &&
  fuzzTally.ok === 0;

if (passed) {
  console.log("\n✅ Anti-replay protection works under load");
  console.log(
    `   stampede ${stampedeTally.ok}/${CONCURRENCY} succeeded, flood ${floodTally.ok} succeeded, fuzz ${fuzzTally.ok} succeeded`,
  );
  process.exit(0);
}

console.log("\n❌ Anti-replay protection FAILED under load");
if (stampedeTally.ok !== 1) {
  console.log(`   expected exactly 1 stampede success, got ${stampedeTally.ok}`);
}
if (floodTally.ok !== 0) {
  console.log(`   expected 0 flood successes, got ${floodTally.ok}`);
}
if (fuzzTally.ok !== 0) {
  console.log(`   expected 0 fuzz successes, got ${fuzzTally.ok}`);
}
process.exit(1);
