/**
 * Replay attack test — verifies that the same payment header
 * cannot be used twice (anti-replay protection).
 */
import { AztecAddress, createPXEClient, waitForPXE } from "@aztec/aztec.js";
import { getDeployedTestAccountsWallets } from "@aztec/accounts/testing";
import { TokenContract } from "@aztec/noir-contracts.js/Token";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { ExactAztecClientScheme } from "@aztech-x402/mechanism/exact/client";
import { RealClientAztecSigner } from "./client-signer.js";

const SERVER_URL = "http://localhost:4402";
const CONFIG_PATH = join(dirname(new URL(import.meta.url).pathname), "deploy.json");
const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

const pxe = createPXEClient(config.pxeUrl);
await waitForPXE(pxe);

const wallets = await getDeployedTestAccountsWallets(pxe);
const aliceWallet = wallets[0];
const tokenAddress = AztecAddress.fromString(config.tokenAddress);
const token = await TokenContract.at(tokenAddress, aliceWallet);

const clientSigner = new RealClientAztecSigner(aliceWallet, token);
const scheme = new ExactAztecClientScheme(clientSigner);

// Step 1: Get 402 + requirements
const initialResp = await fetch(SERVER_URL + "/api/weather");
console.log("Step 1 — Initial response:", initialResp.status);

const payReqHeader = initialResp.headers.get("payment-required");
if (!payReqHeader) { console.error("No payment-required header"); process.exit(1); }

const paymentRequired = JSON.parse(Buffer.from(payReqHeader, "base64").toString());
const requirements = paymentRequired.accepts[0];

// Step 2: Create payment payload
const payloadResult = await scheme.createPaymentPayload(paymentRequired.x402Version, requirements);
const fullPayload = {
  x402Version: payloadResult.x402Version,
  accepted: requirements,
  payload: payloadResult.payload,
  extensions: payloadResult.extensions,
};
const encoded = Buffer.from(JSON.stringify(fullPayload)).toString("base64");

// Step 3: Send payment (should succeed — 200)
console.log("\nStep 2 — First payment request...");
const resp1 = await fetch(SERVER_URL + "/api/weather", {
  headers: { "PAYMENT-SIGNATURE": encoded },
});
console.log(`  Status: ${resp1.status}`);
const body1 = await resp1.json();
console.log("  Body:", JSON.stringify(body1, null, 2));

// Step 4: Replay the EXACT same header (should fail — 402 "payment already used")
console.log("\nStep 3 — REPLAY (same header)...");
const resp2 = await fetch(SERVER_URL + "/api/weather", {
  headers: { "PAYMENT-SIGNATURE": encoded },
});
console.log(`  Status: ${resp2.status}`);
const body2 = await resp2.json();
console.log("  Body:", JSON.stringify(body2, null, 2));

// Verdict
if (resp1.status === 200 && resp2.status === 402) {
  console.log("\n✅ Anti-replay protection works!");
} else {
  console.log("\n❌ Anti-replay protection FAILED");
  process.exit(1);
}
