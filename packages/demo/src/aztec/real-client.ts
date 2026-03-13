/**
 * Real x402 demo client — connects to Aztec node,
 * pays for a weather API call with private tokens.
 *
 * Prerequisites: run setup.ts first, then start real-server.ts.
 *
 * Usage: bun run packages/demo/src/aztec/real-client.ts
 */
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { TokenContract } from "@aztec-x402/contracts/Token";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { readFileSync } from "fs";
import { join, dirname } from "path";

import { ExactAztecClientScheme } from "@aztec-x402/mechanism/exact/client";
import { wrapFetchWithPayment } from "@aztec-x402/client";
import { RealClientAztecSigner } from "./client-signer.js";
import { loadKeys, loadAccount, setupSponsoredPayment } from "./wallet-manager.js";

const SERVER_URL = process.env.SERVER_URL ?? "https://aztec-x402.unfazed.engineering";

// Load deployment config
const __dirname = dirname(new URL(import.meta.url).pathname);
const DATA_DIR = process.env.DATA_DIR ?? __dirname;
const CONFIG_PATH = join(DATA_DIR, "deploy.json");
const KEYS_PATH = join(DATA_DIR, "keys.json");
let config: Record<string, string>;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
} catch {
  console.error("deploy.json not found. Run setup first:");
  console.error("  bun run packages/demo/src/aztec/setup.ts");
  process.exit(1);
}

const NODE_URL = config.nodeUrl;
const NETWORK = config.network;
const USE_SPONSORED_FPC = process.env.USE_SPONSORED_FPC === "true";
const isDevnet = USE_SPONSORED_FPC || NETWORK !== "aztec:sandbox";

// Connect to Aztec
console.log(`Connecting to Aztec node at ${NODE_URL}...`);
const node = createAztecNodeClient(NODE_URL);
const wallet = await EmbeddedWallet.create(node, {
  ephemeral: true,
  pxeConfig: { proverEnabled: isDevnet },
});

// Get Alice's wallet (the payer)
const keys = loadKeys(KEYS_PATH);
const aliceAccount = await loadAccount(wallet, keys, "alice");
const alice = aliceAccount.address;
console.log(`Payer address: ${alice}`);

// Get the deployed token contract
const tokenAddress = AztecAddress.fromString(config.tokenAddress);
const tokenInstance = await node.getContract(tokenAddress);
if (tokenInstance) {
  await wallet.registerContract(tokenInstance, TokenContract.artifact);
}
const token = await TokenContract.at(tokenAddress, wallet);

// Register Bob as sender so we can discover notes from him
const bob = AztecAddress.fromString(config.bobAddress);
await wallet.registerSender(bob, "bob");

// Check balance before
const balanceBefore = await token.methods
  .balance_of_private(alice)
  .simulate({ from: alice });
console.log(`Balance before: ${balanceBefore}\n`);

// Set up fee payment (Sponsored FPC on devnet, none on sandbox)
const paymentMethod = isDevnet ? await setupSponsoredPayment(wallet) : undefined;
const feeOpts = paymentMethod ? { fee: { paymentMethod } } : undefined;

// Create real client signer and x402 payment-aware fetch
const clientSigner = new RealClientAztecSigner(aliceAccount, token, feeOpts);
const scheme = new ExactAztecClientScheme(clientSigner);
const payFetch = wrapFetchWithPayment(fetch, scheme);

// Generate a random resource ID
const resourceId = crypto.randomUUID().slice(0, 8);
console.log(`Requesting weather for resource: ${resourceId}`);

// Make the payment-gated request
console.log(`Fetching ${SERVER_URL}/api/weather/${resourceId} (payment-gated)...\n`);
const response = await payFetch(`${SERVER_URL}/api/weather/${resourceId}`);
const data = await response.json();

console.log(`Response (${response.status}):`);
console.log(JSON.stringify(data, null, 2));

// Check balance after
const balanceAfter = await token.methods
  .balance_of_private(alice)
  .simulate({ from: alice });
console.log(`\nBalance after: ${balanceAfter}`);
console.log(`Spent: ${Number(balanceBefore) - Number(balanceAfter)}`);
process.exit(0);
