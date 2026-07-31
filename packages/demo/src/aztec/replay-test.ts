/**
 * Replay attack test — verifies that the same payment header
 * cannot be used twice (anti-replay protection).
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
const __dirname = dirname(new URL(import.meta.url).pathname);
const DATA_DIR = process.env.DATA_DIR ?? __dirname;
const CONFIG_PATH = join(DATA_DIR, "deploy.json");
const KEYS_PATH = join(DATA_DIR, "keys.json");
const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

// The middleware serves an already-paid resource for free, so the replay must
// target a DIFFERENT, unpaid resource — otherwise the second 200 proves nothing.
// Fresh ids per run keep a previous run's paid-resource cache out of the way.
const RUN_ID = crypto.randomUUID().slice(0, 8);
const PAID_PATH = `/api/weather/replay-paid-${RUN_ID}`;
const REPLAY_PATH = `/api/weather/replay-target-${RUN_ID}`;

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

// Step 1: Get 402 + requirements
const initialResp = await fetch(SERVER_URL + PAID_PATH);
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
const prepareResp = await fetch(SERVER_URL + PAID_PATH, {
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

// Step 4: Send payment (should succeed — 200)
console.log("\nStep 4 — First payment request...");
const resp1 = await fetch(SERVER_URL + PAID_PATH, {
  headers: { "PAYMENT-SIGNATURE": encoded },
});
console.log(`  Status: ${resp1.status}`);
const body1 = await resp1.json();
console.log("  Body:", JSON.stringify(body1, null, 2));

// Step 5: Replay the EXACT same header (should fail — 402 "payment already used")
console.log(`\nStep 5 — REPLAY (same header, unpaid resource ${REPLAY_PATH})...`);
const resp2 = await fetch(SERVER_URL + REPLAY_PATH, {
  headers: { "PAYMENT-SIGNATURE": encoded },
});
console.log(`  Status: ${resp2.status}`);
const body2 = await resp2.json();
console.log("  Body:", JSON.stringify(body2, null, 2));

// Verdict
if (resp1.status === 200 && resp2.status === 402) {
  console.log("\n✅ Anti-replay protection works!");
  process.exit(0);
} else {
  console.log("\n❌ Anti-replay protection FAILED");
  process.exit(1);
}
