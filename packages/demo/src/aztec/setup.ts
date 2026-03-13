/**
 * Setup script for the real Aztec demo.
 *
 * Connects to an Aztec node (sandbox or devnet), deploys accounts and a token contract,
 * mints tokens to the payer, and writes deployment info to a config file.
 *
 * Resumable: saves progress to deploy.json after each step. Safe to restart.
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
import { Fr } from "@aztec/aztec.js/fields";
import { TokenContract } from "@aztec-x402/contracts/Token";
import { createPXEWallet } from "./pxe-wallet.js";
import { writeFileSync, existsSync, readFileSync } from "fs";
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

/** Load partial config if it exists */
function loadConfig(): Record<string, string> {
  if (existsSync(CONFIG_PATH)) {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  }
  return {};
}

/** Save config incrementally */
function saveConfig(config: Record<string, unknown>) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function main() {
  console.log(`Connecting to Aztec node at ${NODE_URL}...`);
  const node = createAztecNodeClient(NODE_URL);
  const isDevnet = USE_SPONSORED_FPC || NETWORK !== "aztec:sandbox";
  const wallet = await createPXEWallet(node, {
    ephemeral: true,
    pxeConfig: { proverEnabled: isDevnet },
  });
  console.log("Connected.\n");

  const paymentMethod = USE_SPONSORED_FPC
    ? await setupSponsoredPayment(wallet)
    : undefined;

  if (paymentMethod) {
    console.log("Using Sponsored FPC for fee payment.\n");
  }

  // Load any existing partial config
  const config = loadConfig();
  config.nodeUrl = NODE_URL;
  config.network = NETWORK;

  // Step 1: Ensure keys
  const keys = await ensureKeys(KEYS_PATH, wallet);
  config.aliceAddress = keys.alice.address;
  config.bobAddress = keys.bob.address;
  saveConfig(config);

  // Step 2: Deploy accounts
  console.log("Deploying accounts...");
  const { aliceAccount, bobAccount } = await deployAccounts(wallet, node, keys, {
    paymentMethod,
    timeout: TX_TIMEOUT,
  });
  const alice = aliceAccount.address;
  const bob = bobAccount.address;
  console.log(`  Alice (payer):       ${alice}`);
  console.log(`  Bob   (server):      ${bob}\n`);

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

  // Step 3: Deploy token (skip if already recorded and exists on-chain)
  let tokenAddress: AztecAddress;
  if (config.tokenAddress) {
    const existing = AztecAddress.fromString(config.tokenAddress);
    const onChain = await node.getContract(existing);
    if (onChain) {
      console.log(`Token already deployed at ${existing} — skipping.\n`);
      tokenAddress = existing;
    } else {
      console.log(`Token address ${existing} recorded but not found on-chain — redeploying.\n`);
      config.tokenAddress = "";
      config.minted = "";
    }
  }

  if (!config.tokenAddress) {
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
    tokenAddress = token.address;
    console.log(`  Token deployed at:   ${tokenAddress}\n`);

    config.tokenAddress = tokenAddress.toString();
    config.tokenName = TOKEN_NAME;
    config.tokenSymbol = TOKEN_SYMBOL;
    config.tokenDecimals = String(TOKEN_DECIMALS);
    saveConfig(config);
  }

  // Step 4: Mint tokens (skip if already done)
  if (config.minted !== "true") {
    const tokenInstance = await node.getContract(tokenAddress!);
    if (tokenInstance) {
      await wallet.registerContract(tokenInstance, TokenContract.artifact);
    }
    const token = await TokenContract.at(tokenAddress!, wallet);

    console.log(`Minting ${MINT_AMOUNT} to Alice's private balance...`);
    await token.methods
      .mint_to_private(alice, MINT_AMOUNT)
      .simulate({ from: alice });
    await token.methods
      .mint_to_private(alice, MINT_AMOUNT)
      .send(sendOpts(alice));

    const aliceBalance = await token.methods
      .balance_of_private(alice)
      .simulate({ from: alice });
    console.log(`  Alice's balance:     ${aliceBalance}\n`);

    config.minted = "true";
    config.mintAmount = MINT_AMOUNT.toString();
    saveConfig(config);
  } else {
    console.log("Tokens already minted — skipping.\n");
  }

  // Step 5: Register cross-party senders
  console.log("Registering cross-party senders...");
  await wallet.registerSender(bob, "bob");
  await wallet.registerSender(alice, "alice");
  console.log("  Done.\n");

  console.log(`Config written to ${CONFIG_PATH}`);
  console.log("\nSetup complete!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
