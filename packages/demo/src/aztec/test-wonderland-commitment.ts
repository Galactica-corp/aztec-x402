/**
 * Phase 0: Standalone test for commitment pattern on official Aztec TokenContract.
 *
 * Validates that prepare_private_balance_increase + finalize_transfer_to_private_from_private
 * works on-chain before integrating into the x402 protocol.
 *
 * Usage: bun run packages/demo/src/aztec/test-wonderland-commitment.ts
 *
 * Prerequisites: run setup.ts first to deploy token contract.
 */
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { TokenContract } from "@aztec-x402/contracts/Token";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { loadKeys, loadAccount, setupSponsoredPayment } from "./wallet-manager.js";

const __dirname = dirname(new URL(import.meta.url).pathname);
const DATA_DIR = process.env.DATA_DIR ?? __dirname;
const CONFIG_PATH = join(DATA_DIR, "deploy.json");
const KEYS_PATH = join(DATA_DIR, "keys.json");
const USE_SPONSORED_FPC = process.env.USE_SPONSORED_FPC === "true";

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
const isDevnet = USE_SPONSORED_FPC || NETWORK !== "aztec:sandbox";
const TRANSFER_AMOUNT = 10000n;

console.log("=== Phase 0: Commitment Pattern Test (forked x402 TokenContract) ===\n");

// 1. Connect to Aztec node
console.log(`Connecting to Aztec node at ${NODE_URL}...`);
const node = createAztecNodeClient(NODE_URL);
const wallet = await EmbeddedWallet.create(node, {
  ephemeral: true,
  pxeConfig: { proverEnabled: isDevnet },
});

// 2. Load Alice (payer) and Bob (facilitator) accounts
const keys = loadKeys(KEYS_PATH);
const aliceAccount = await loadAccount(wallet, keys, "alice");
const bobAccount = await loadAccount(wallet, keys, "bob");
const alice = aliceAccount.address;
const bob = bobAccount.address;
console.log(`Alice (payer):      ${alice}`);
console.log(`Bob (facilitator):  ${bob}`);

// 3. Load TokenContract
const tokenAddress = AztecAddress.fromString(config.tokenAddress);
const tokenInstance = await node.getContract(tokenAddress);
if (tokenInstance) {
  await wallet.registerContract(tokenInstance, TokenContract.artifact);
}
const token = await TokenContract.at(tokenAddress, wallet);
console.log(`Token:              ${tokenAddress}\n`);

// Register senders for note discovery
await wallet.registerSender(bob, "bob");
await wallet.registerSender(alice, "alice");

// Set up fee payment if needed
const paymentMethod = isDevnet ? await setupSponsoredPayment(wallet) : undefined;
const feeOpts = paymentMethod ? { fee: { paymentMethod } } : {};

// 4. Check Alice's balance before
const balanceBefore = await token.methods
  .balance_of_private(alice)
  .simulate({ from: alice });
console.log(`Alice balance before: ${balanceBefore}`);

if (BigInt(String(balanceBefore)) < TRANSFER_AMOUNT) {
  console.error(`\nERROR: Alice needs at least ${TRANSFER_AMOUNT} tokens`);
  process.exit(1);
}

// 5. Bob calls: prepare_private_balance_increase(bobAddr, aliceAddr)
console.log("\nStep 1: Bob creates commitment (prepare_private_balance_increase with completer=alice)...");
try {
  const interaction = token.methods.prepare_private_balance_increase(bob, alice);
  const commitmentResult = await interaction.simulate({ from: bob });
  console.log(`  simulate() succeeded, result: ${String(commitmentResult)}`);

  // Extract commitment field
  let commitment: unknown;
  if (commitmentResult != null && typeof commitmentResult === "object" && "commitment" in commitmentResult) {
    commitment = (commitmentResult as { commitment: unknown }).commitment;
  } else {
    commitment = commitmentResult;
  }
  console.log(`  Commitment: ${String(commitment)}`);

  const sendOpts: Record<string, unknown> = { from: bob, wait: { timeout: 120 }, ...feeOpts };
  const receipt = await interaction.send(sendOpts);
  console.log(`  Tx mined: ${receipt.txHash}`);

  // 6. Alice calls: finalize_transfer_to_private_from_private(aliceAddr, {commitment}, amount, 0)
  console.log(`\nStep 2: Alice completes transfer (finalize_transfer_to_private_from_private, amount=${TRANSFER_AMOUNT})...`);
  const transferInteraction = token.methods.finalize_transfer_to_private_from_private(
    alice,
    { commitment },
    TRANSFER_AMOUNT,
    0,
  );

  const transferSimResult = await transferInteraction.simulate({ from: alice });
  console.log(`  simulate() succeeded: ${String(transferSimResult)}`);

  const transferOpts: Record<string, unknown> = { from: alice, wait: { timeout: 120 }, ...feeOpts };
  const transferReceipt = await transferInteraction.send(transferOpts);
  console.log(`  Tx mined: ${transferReceipt.txHash}`);

  // 7. Verify tx receipt
  const txHash = transferReceipt.txHash;
  const txReceipt = await node.getTxReceipt(txHash);
  console.log(`\nVerification:`);
  console.log(`  Tx status: ${txReceipt.status}`);

  const txEffect = await node.getTxEffect(txHash);
  if (txEffect) {
    const noteHashes = (txEffect as { data?: { noteHashes?: unknown[] } }).data?.noteHashes ??
      (txEffect as { noteHashes?: unknown[] }).noteHashes ?? [];
    const nonEmpty = noteHashes.filter((h: unknown) => {
      const s = String(h);
      return s !== "0" && s !== "0x0" && !/^0x0+$/.test(s);
    });
    console.log(`  Notes created: ${nonEmpty.length}`);
  }

  // 8. Check Alice's balance after
  const balanceAfter = await token.methods
    .balance_of_private(alice)
    .simulate({ from: alice });
  console.log(`\nAlice balance after:  ${balanceAfter}`);
  console.log(`Spent: ${Number(balanceBefore) - Number(balanceAfter)}`);

  console.log("\n=== SUCCESS: Commitment pattern works on 4.0.4! ===");
  console.log("Proceed to Phase 1 integration.\n");
} catch (err) {
  console.error("\n=== FAILED ===");
  console.error(err);
  if (String(err).includes("Nullifier witness not found")) {
    console.error(
      "\nThe commitment pattern still has the nullifier bug in this version.",
    );
    console.error("Escalate to Aztec team or find a workaround.");
  }
  process.exit(1);
}

process.exit(0);
