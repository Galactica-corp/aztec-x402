/**
 * Setup script for the real Aztec demo.
 *
 * Connects to an Aztec node (sandbox or devnet), deploys accounts and a token contract,
 * mints tokens to the payer, and writes deployment info to a config file.
 *
 * Usage: bun run packages/demo/src/aztec/setup.ts
 *
 * Environment variables:
 *   NODE_URL  — Aztec node URL (default: http://localhost:8080)
 *   AZTEC_NETWORK — CAIP-2 network id (default: aztec:sandbox)
 *   USE_SPONSORED_FPC — set to "true" to use Sponsored FPC for fees (devnet)
 */
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { TokenContract } from "@aztec/noir-contracts.js/Token";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { ensureKeys, deployAccounts, setupSponsoredPayment } from "./wallet-manager.js";

const NODE_URL = process.env.NODE_URL ?? "http://localhost:8080";
const NETWORK = process.env.AZTEC_NETWORK ?? "aztec:sandbox";
const USE_SPONSORED_FPC = process.env.USE_SPONSORED_FPC === "true";
const TOKEN_NAME = "Overcast USD";
const TOKEN_SYMBOL = "oUSD";
const TOKEN_DECIMALS = 6;
const MINT_AMOUNT = 1_000_000n; // 1.0 oUSD (6 decimals)
const TX_TIMEOUT = 120;

const __dirname = dirname(new URL(import.meta.url).pathname);
const DATA_DIR = process.env.DATA_DIR ?? __dirname;
const CONFIG_PATH = join(DATA_DIR, "deploy.json");
const KEYS_PATH = join(DATA_DIR, "keys.json");

async function main() {
  console.log(`Connecting to Aztec node at ${NODE_URL}...`);
  const node = createAztecNodeClient(NODE_URL);
  const isDevnet = USE_SPONSORED_FPC || NETWORK !== "aztec:sandbox";
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxeConfig: { proverEnabled: isDevnet },
  });
  console.log("Connected.\n");

  // Set up Sponsored FPC payment method (devnet) or undefined (sandbox)
  const paymentMethod = USE_SPONSORED_FPC
    ? await setupSponsoredPayment(wallet)
    : undefined;

  if (paymentMethod) {
    console.log("Using Sponsored FPC for fee payment.\n");
  }

  // Ensure Schnorr account keys exist (generate if first run)
  const keys = await ensureKeys(KEYS_PATH, wallet);

  // Deploy accounts (skips if already registered)
  console.log("Deploying accounts...");
  const { aliceAccount, bobAccount } = await deployAccounts(wallet, node, keys, {
    paymentMethod,
    timeout: TX_TIMEOUT,
  });
  const alice = aliceAccount.address;
  const bob = bobAccount.address;
  console.log(`  Alice (payer):       ${alice}`);
  console.log(`  Bob   (server):      ${bob}\n`);

  // Build send options (with fee payment on devnet)
  const sendOpts = (from: AztecAddress) => {
    const opts: Record<string, unknown> = {
      from,
      wait: { timeout: TX_TIMEOUT },
    };
    if (paymentMethod) {
      opts.fee = { paymentMethod };
    }
    return opts;
  };

  // Deploy token contract (Alice is admin)
  console.log(`Deploying ${TOKEN_NAME} (${TOKEN_SYMBOL})...`);
  const tokenDeploy = TokenContract.deploy(
    wallet,
    alice,
    TOKEN_NAME,
    TOKEN_SYMBOL,
    TOKEN_DECIMALS,
  );
  await tokenDeploy.simulate({ from: alice });
  const token = await tokenDeploy.send(sendOpts(alice));
  console.log(`  Token deployed at:   ${token.address}\n`);

  // Mint tokens to Alice's private balance
  console.log(`Minting ${MINT_AMOUNT} to Alice's private balance...`);
  await token.methods
    .mint_to_private(alice, MINT_AMOUNT)
    .simulate({ from: alice });
  await token.methods
    .mint_to_private(alice, MINT_AMOUNT)
    .send(sendOpts(alice));

  // Verify balance
  const aliceBalance = await token.methods
    .balance_of_private(alice)
    .simulate({ from: alice });
  console.log(`  Alice's balance:     ${aliceBalance}\n`);

  // Register cross-party senders so both sides can discover notes
  console.log("Registering cross-party senders...");
  await wallet.registerSender(bob, "bob");
  await wallet.registerSender(alice, "alice");
  console.log("  Done.\n");

  // Register the token contract for Bob's view
  console.log("Registering token contract for Bob...");
  const tokenInstance = await node.getContract(token.address);
  if (tokenInstance) {
    await wallet.registerContract(tokenInstance, TokenContract.artifact);
  }
  console.log("  Done.\n");

  // Write deployment config
  const config = {
    nodeUrl: NODE_URL,
    tokenAddress: token.address.toString(),
    tokenName: TOKEN_NAME,
    tokenSymbol: TOKEN_SYMBOL,
    tokenDecimals: TOKEN_DECIMALS,
    aliceAddress: alice.toString(),
    bobAddress: bob.toString(),
    mintAmount: MINT_AMOUNT.toString(),
    network: NETWORK,
  };

  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`Config written to ${CONFIG_PATH}`);
  console.log("\nSetup complete! Run the demo:");
  console.log("  Terminal 1: bun run packages/demo/src/aztec/real-server.ts");
  console.log("  Terminal 2: bun run packages/demo/src/aztec/real-client.ts");
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
