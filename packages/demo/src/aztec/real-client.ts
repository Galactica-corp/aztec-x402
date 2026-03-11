/**
 * Real x402 demo client — connects to Aztec sandbox,
 * pays for a weather API call with private tokens.
 *
 * Prerequisites: run setup.ts first, then start real-server.ts.
 *
 * Usage: bun run packages/demo/src/aztec/real-client.ts
 */
import { AztecAddress, createPXEClient, waitForPXE } from "@aztec/aztec.js";
import { getDeployedTestAccountsWallets } from "@aztec/accounts/testing";
import { TokenContract } from "@aztec/noir-contracts.js/Token";
import { readFileSync } from "fs";
import { join, dirname } from "path";

import { ExactAztecClientScheme } from "@aztech-x402/mechanism/exact/client";
import { wrapFetchWithPayment } from "@aztech-x402/client";
import { RealClientAztecSigner } from "./client-signer.js";

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:4402";

// Load deployment config
const CONFIG_PATH = join(dirname(new URL(import.meta.url).pathname), "deploy.json");
let config: Record<string, string>;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
} catch {
  console.error("deploy.json not found. Run setup first:");
  console.error("  bun run packages/demo/src/aztec/setup.ts");
  process.exit(1);
}

const PXE_URL = config.pxeUrl;

// Connect to Aztec
console.log(`Connecting to Aztec sandbox at ${PXE_URL}...`);
const pxe = createPXEClient(PXE_URL);
await waitForPXE(pxe);

// Get Alice's wallet (the payer)
const wallets = await getDeployedTestAccountsWallets(pxe);
const aliceWallet = wallets[0];
const alice = aliceWallet.getAddress();
console.log(`Payer address: ${alice}`);

// Get the deployed token contract
const tokenAddress = AztecAddress.fromString(config.tokenAddress);
const token = await TokenContract.at(tokenAddress, aliceWallet);

// Check balance before
const balanceBefore = await token.methods
  .balance_of_private(alice)
  .simulate();
console.log(`Balance before: ${balanceBefore}\n`);

// Create real client signer and x402 payment-aware fetch
const clientSigner = new RealClientAztecSigner(aliceWallet, token);
const scheme = new ExactAztecClientScheme(clientSigner);
const payFetch = wrapFetchWithPayment(fetch, scheme);

// Make the payment-gated request
console.log(`Fetching ${SERVER_URL}/api/weather (payment-gated)...\n`);
const response = await payFetch(`${SERVER_URL}/api/weather`);
const data = await response.json();

console.log(`Response (${response.status}):`);
console.log(JSON.stringify(data, null, 2));

// Check balance after
const balanceAfter = await token.methods
  .balance_of_private(alice)
  .simulate();
console.log(`\nBalance after: ${balanceAfter}`);
console.log(`Spent: ${Number(balanceBefore) - Number(balanceAfter)}`);
