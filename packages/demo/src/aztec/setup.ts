/**
 * Setup script for the real Aztec demo.
 *
 * Connects to a running Aztec sandbox, deploys a token contract,
 * mints tokens to the payer, and writes deployment info to a config file.
 *
 * Usage: bun run packages/demo/src/aztec/setup.ts
 */
import { createPXEClient, waitForPXE } from "@aztec/aztec.js";
import { getDeployedTestAccountsWallets } from "@aztec/accounts/testing";
import { TokenContract } from "@aztec/noir-contracts.js/Token";
import { writeFileSync } from "fs";
import { join, dirname } from "path";

const PXE_URL = process.env.PXE_URL ?? "http://localhost:8080";
const TOKEN_NAME = "Overcast USD";
const TOKEN_SYMBOL = "oUSD";
const TOKEN_DECIMALS = 6;
const MINT_AMOUNT = 1_000_000n; // 1.0 oUSD (6 decimals)

const CONFIG_PATH = join(dirname(new URL(import.meta.url).pathname), "deploy.json");

async function main() {
  console.log(`Connecting to Aztec sandbox at ${PXE_URL}...`);
  const pxe = createPXEClient(PXE_URL);
  await waitForPXE(pxe);
  console.log("Connected.\n");

  // Get pre-deployed test accounts (Alice = payer, Bob = server/facilitator)
  console.log("Loading test accounts...");
  const wallets = await getDeployedTestAccountsWallets(pxe);
  if (wallets.length < 2) {
    throw new Error("Need at least 2 test accounts. Run: aztec-wallet import-test-accounts");
  }
  const [aliceWallet, bobWallet] = wallets;
  const alice = aliceWallet.getAddress();
  const bob = bobWallet.getAddress();
  console.log(`  Alice (payer):       ${alice}`);
  console.log(`  Bob   (server):      ${bob}\n`);

  // Deploy token contract (Alice is admin)
  console.log(`Deploying ${TOKEN_NAME} (${TOKEN_SYMBOL})...`);
  const token = await TokenContract.deploy(
    aliceWallet,
    alice,
    TOKEN_NAME,
    TOKEN_SYMBOL,
    TOKEN_DECIMALS,
  ).send().deployed();
  console.log(`  Token deployed at:   ${token.address}\n`);

  // Mint tokens to Alice's private balance
  console.log(`Minting ${MINT_AMOUNT} to Alice's private balance...`);
  await token.methods
    .mint_to_private(alice, alice, MINT_AMOUNT)
    .send()
    .wait();

  // Verify balance
  const aliceBalance = await token.methods
    .balance_of_private(alice)
    .simulate();
  console.log(`  Alice's balance:     ${aliceBalance}\n`);

  // Register Bob as a sender on Alice's PXE (and vice versa)
  // so both PXEs can discover cross-party notes
  console.log("Registering cross-party senders...");
  await pxe.registerSender(bob);
  await pxe.registerSender(alice);
  console.log("  Done.\n");

  // Register the token contract on Bob's wallet
  // (In sandbox with shared PXE, this may be automatic,
  //  but we do it explicitly for correctness)
  console.log("Registering token contract for Bob...");
  const tokenAsBob = await TokenContract.at(token.address, bobWallet);
  console.log("  Done.\n");

  // Write deployment config
  const config = {
    pxeUrl: PXE_URL,
    tokenAddress: token.address.toString(),
    tokenName: TOKEN_NAME,
    tokenSymbol: TOKEN_SYMBOL,
    tokenDecimals: TOKEN_DECIMALS,
    aliceAddress: alice.toString(),
    bobAddress: bob.toString(),
    mintAmount: MINT_AMOUNT.toString(),
    network: "aztec:sandbox",
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
