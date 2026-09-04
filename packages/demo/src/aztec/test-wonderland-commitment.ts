/**
 * Phase 0: Standalone test for commitment pattern on official Aztec TokenContract.
 *
 * Validates that initialize_transfer_commitment + transfer_private_to_commitment
 * works on-chain before integrating into the x402 protocol.
 *
 * Usage: bun run packages/demo/src/aztec/test-wonderland-commitment.ts
 *
 * Prerequisites: run setup.ts first to deploy token contract.
 */
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { TokenContract } from "@aztec-foundation/aztec-standards/dist/src/artifacts/Token.js";
import { getAztecTxEffectArray, unwrapAztecSdkResult } from "@galactica-net/x402-core";
import { createPXEWallet } from "./pxe-wallet.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { loadKeys, loadAccount, setupSponsoredPayment } from "./wallet-manager.js";
import { shouldEnableProver } from "./network-config.js";

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
const proverEnabled = shouldEnableProver(NETWORK);
const TRANSFER_AMOUNT = 10000n;

function getConstructorName(value: unknown): string | undefined {
  return value != null && typeof value === "object"
    ? value.constructor?.name
    : undefined;
}

console.log("=== Phase 0: Commitment Pattern Test (AIP-20 TokenContract) ===\n");

// 1. Connect to Aztec node
console.log(`Connecting to Aztec node at ${NODE_URL}...`);
const node = createAztecNodeClient(NODE_URL);
const wallet = await createPXEWallet(node, {
  ephemeral: true,
  pxe: { proverEnabled },
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
const tokenAddress = AztecAddress.fromStringUnsafe(config.tokenAddress);
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
const paymentMethod = USE_SPONSORED_FPC
  ? await setupSponsoredPayment(wallet)
  : undefined;
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

// 5. Test: Same-person flow first (Alice calls both prepare and finalize)
console.log("\nStep 1: Alice creates commitment (initialize_transfer_commitment with completer=alice)...");
try {
  const interaction = token.methods.initialize_transfer_commitment(alice, alice);
  const commitmentResult = await interaction.simulate({ from: alice });
  console.log(`  simulate() succeeded, result: ${String(commitmentResult)}`);

  // Extract commitment field — AIP-20 returns Field directly
  // v4.1.0 wraps in { result: Field }, otherwise it's the raw Field
  const commitment = unwrapAztecSdkResult(commitmentResult);
  console.log(`  Commitment: ${String(commitment)}`);

  const { receipt } = await interaction.send({ from: alice, wait: { timeout: 120 }, ...feeOpts });
  console.log(`  Tx mined: ${receipt.txHash}`);

  // Debug: Check what nullifiers the prepare tx created
  const prepareEffect = await node.getTxEffect(receipt.txHash);
  if (prepareEffect) {
    const nullifiers = getAztecTxEffectArray(prepareEffect, "nullifiers");
    const nonZero = nullifiers.filter((n: unknown) => {
      const s = String(n);
      return s !== "0" && s !== "0x0" && !/^0x0+$/.test(s);
    });
    console.log(`\n  Prepare tx nullifiers (${nonZero.length}):`);
    for (const n of nonZero) {
      console.log(`    ${String(n)}`);
    }
  }

  // Debug: Check prepare tx block
  const prepareReceipt = await node.getTxReceipt(receipt.txHash);
  console.log(`\n  Prepare tx block number: ${prepareReceipt.blockNumber}`);
  console.log(`  Current node block number: ${await node.getBlockNumber()}`);

  // Debug: log commitment details
  console.log(`\n  Commitment type: ${typeof commitment}, constructor: ${getConstructorName(commitment)}`);
  console.log(`  Full commitmentResult: ${JSON.stringify(commitmentResult, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`);

  // 6. Alice calls: transfer_private_to_commitment(aliceAddr, {commitment}, amount, 0)
  console.log(`\nStep 2: Alice completes transfer (transfer_private_to_commitment, amount=${TRANSFER_AMOUNT})...`);
  // simulate() returns a SimulationResult wrapper, so pass the unwrapped
  // commitment field rather than the whole result object.
  const transferInteraction = token.methods.transfer_private_to_commitment(
    alice,
    Fr.fromString(String(commitment)),
    TRANSFER_AMOUNT,
    0,
  );

  const transferSimResult = await transferInteraction.simulate({ from: alice });
  console.log(`  simulate() succeeded: ${String(transferSimResult)}`);

  const { receipt: transferReceipt } = await transferInteraction.send({
    from: alice,
    wait: { timeout: 120 },
    ...feeOpts,
  });
  console.log(`  Tx mined: ${transferReceipt.txHash}`);

  // 7. Verify tx receipt
  const txHash = transferReceipt.txHash;
  const txReceipt = await node.getTxReceipt(txHash);
  console.log(`\nVerification:`);
  console.log(`  Tx status: ${txReceipt.status}`);

  const txEffect = await node.getTxEffect(txHash);
  if (txEffect) {
    const noteHashes = getAztecTxEffectArray(txEffect, "noteHashes");
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
