/**
 * Real x402 demo client — connects to Aztec node,
 * pays for a weather API call with private tokens.
 *
 * Prerequisites: run setup.ts first, then start real-server.ts.
 *
 * Usage: bun run packages/demo/src/aztec/real-client.ts
 */
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { TokenRegistry } from "@galactica-net/x402-agent/aztec";
import { readFileSync } from "fs";
import { join, dirname } from "path";

import { ExactAztecClientScheme } from "@galactica-net/x402-mechanism/exact/client";
import { wrapFetchWithPayment } from "@galactica-net/x402-client";
import { RealClientAztecSigner } from "./client-signer.js";
import { loadKeys, loadAccount, openDemoWallet, setupSponsoredPayment } from "./wallet-manager.js";
import { shouldEnableProver } from "./network-config.js";

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:4402";

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
const proverEnabled = shouldEnableProver(NETWORK);

// Connect to Aztec
console.log(`Connecting to Aztec node at ${NODE_URL}...`);
const node = createAztecNodeClient(NODE_URL);
const { wallet, paymentGate } = await openDemoWallet(node, proverEnabled, config.tokenAddress);

// Get Alice's wallet (the payer)
const keys = loadKeys(KEYS_PATH);
const aliceAccount = await loadAccount(wallet, keys, "alice");
const alice = aliceAccount.address;
console.log(`Payer address: ${alice}`);

// Register Bob as sender so we can discover notes from him
const bob = AztecAddress.fromStringUnsafe(config.bobAddress);
await wallet.registerSender(bob, "bob");

const paymentMethod = USE_SPONSORED_FPC
  ? await setupSponsoredPayment(wallet)
  : undefined;
const fee = paymentMethod ? { paymentMethod } : undefined;

// The token's kind is read from the chain; the signer pays accordingly.
const tokens = new TokenRegistry({ node, wallet, account: alice, fee, paymentGate });
const token = await tokens.get(config.tokenAddress);
console.log(`Paying in token ${config.tokenAddress} (${token.kind})`);

// Check balance before
const balanceBefore = await token.privateBalance();
console.log(`Balance before: ${balanceBefore}\n`);

// Create real client signer and x402 payment-aware fetch
const clientSigner = new RealClientAztecSigner(aliceAccount, tokens);
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
const balanceAfter = await token.privateBalance();
console.log(`\nBalance after: ${balanceAfter}`);
console.log(`Spent: ${balanceBefore - balanceAfter}`);
process.exit(0);
