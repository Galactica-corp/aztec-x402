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
 *   USE_SPONSORED_FPC — set to "true" for Sponsored FPC (public testnet; required for local 4.2+ where fees are non-zero)
 */
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { TxStatus } from "@aztec/aztec.js/tx";
import { TokenContract } from "../contracts/token/Token.js";
import { unwrapAztecSdkResult } from "@galactica-net/x402-core";
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
const TX_TIMEOUT = 240;

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

function extractSimulateValue(result: unknown): unknown {
  return unwrapAztecSdkResult(result);
}

async function main() {
  console.log(`Connecting to Aztec node at ${NODE_URL}...`);
  const node = createAztecNodeClient(NODE_URL);
  const isRemoteNetwork = USE_SPONSORED_FPC || NETWORK !== "aztec:sandbox";
  const wallet = await createPXEWallet(node, {
    ephemeral: true,
    pxe: { proverEnabled: isRemoteNetwork },
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

  const sendOpts = (from: AztecAddress) => ({
    from,
    wait: { timeout: TX_TIMEOUT, waitForStatus: TxStatus.CHECKPOINTED },
    fee: paymentMethod ? { paymentMethod } : undefined,
  });

  // Step 3: Deploy token (skip if already recorded and exists on-chain)
  let tokenAddress: AztecAddress | undefined;
  if (config.tokenAddress) {
    const existing = AztecAddress.fromStringUnsafe(config.tokenAddress);
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
    const tokenDeploy = TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      TOKEN_NAME,
      TOKEN_SYMBOL,
      TOKEN_DECIMALS,
      alice,
      // auth_contract: the token's optional authorization hook, which must
      // implement Wonderland's own interface. Zero disables it — this demo has
      // no authorization policy to enforce.
      AztecAddress.ZERO,
    );
    await tokenDeploy.simulate({ from: alice });
    const deployResult = await tokenDeploy.send(sendOpts(alice));
    tokenAddress = deployResult.contract.address;
    if (!tokenAddress) {
      throw new Error("Could not determine token address after deployment");
    }
    console.log(`  Token deployed at:   ${tokenAddress}\n`);

    config.tokenAddress = tokenAddress.toString();
    config.tokenName = TOKEN_NAME;
    config.tokenSymbol = TOKEN_SYMBOL;
    config.tokenDecimals = String(TOKEN_DECIMALS);
    saveConfig(config);
  }

  if (!tokenAddress) {
    throw new Error("Token address was not set after setup");
  }

  // Step 4: Mint tokens (skip if already done)
  if (config.minted !== "true") {
    const tokenInstance = await node.getContract(tokenAddress);
    if (tokenInstance) {
      await wallet.registerContract(tokenInstance, TokenContract.artifact);
    }
    const token = await TokenContract.at(tokenAddress, wallet);

    console.log(`Minting ${MINT_AMOUNT} to Alice's private balance...`);
    await token.methods
      .mint_to_private(alice, MINT_AMOUNT)
      .simulate({ from: alice });
    await token.methods
      .mint_to_private(alice, MINT_AMOUNT)
      .send(sendOpts(alice));

    try {
      const aliceBalance = await token.methods
        .balance_of_private(alice)
        .simulate({ from: alice });
      console.log(`  Alice's balance:     ${extractSimulateValue(aliceBalance)}\n`);
    } catch {
      console.log("  (balance check skipped — private balance not visible yet)\n");
    }

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
