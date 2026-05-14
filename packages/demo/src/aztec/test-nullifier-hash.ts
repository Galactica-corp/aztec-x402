/**
 * Compute the expected siloed validity commitment nullifier in TypeScript
 * and compare with what the prepare tx actually emitted.
 */
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { TokenContract } from "@defi-wonderland/aztec-standards/dist/src/artifacts/Token.js";
import { getAztecTxEffectArray, unwrapAztecSdkResult } from "@aztec-x402/core";
import { createPXEWallet } from "./pxe-wallet.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { loadKeys, loadAccount, setupSponsoredPayment } from "./wallet-manager.js";

const __dirname = dirname(new URL(import.meta.url).pathname);
const DATA_DIR = process.env.DATA_DIR ?? __dirname;
const CONFIG_PATH = join(DATA_DIR, "deploy.json");
const KEYS_PATH = join(DATA_DIR, "keys.json");

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
const NODE_URL = config.nodeUrl;
const NETWORK = config.network;
const isDevnet = process.env.USE_SPONSORED_FPC === "true" || NETWORK !== "aztec:sandbox";

console.log("=== Nullifier Hash Comparison ===\n");

const node = createAztecNodeClient(NODE_URL);
const wallet = await createPXEWallet(node, {
  ephemeral: true,
  pxeConfig: { proverEnabled: isDevnet },
});

const keys = loadKeys(KEYS_PATH);
const aliceAccount = await loadAccount(wallet, keys, "alice");
const alice = aliceAccount.address;

const tokenAddress = AztecAddress.fromString(config.tokenAddress);
const tokenInstance = await node.getContract(tokenAddress);
if (tokenInstance) {
  await wallet.registerContract(tokenInstance, TokenContract.artifact);
}
const token = await TokenContract.at(tokenAddress, wallet);
await wallet.registerSender(alice, "alice");

const paymentMethod = isDevnet ? await setupSponsoredPayment(wallet) : undefined;
const feeOpts = paymentMethod ? { fee: { paymentMethod } } : {};

// Step 1: Prepare
console.log("Step 1: Alice calls initialize_transfer_commitment(alice, alice)...");
const interaction = token.methods.initialize_transfer_commitment(alice, alice);
const simResult = await interaction.simulate({ from: alice });
const commitment = unwrapAztecSdkResult(simResult);
console.log(`  Commitment value: ${String(commitment)}`);
console.log(`  Commitment type: ${typeof commitment}`);
console.log(`  Commitment constructor: ${commitment?.constructor?.name}`);

// Convert to Fr if needed
const commitmentFr = commitment instanceof Fr ? commitment : new Fr(BigInt(String(commitment)));
console.log(`  Commitment as Fr: ${commitmentFr.toString()}`);
console.log(`  Alice address: ${alice.toString()}`);
console.log(`  Token address: ${tokenAddress.toString()}`);

// Step 2: Compute validity commitment
// validity_commitment = poseidon2_hash_with_separator([commitment, completer], DOM_SEP__PARTIAL_NOTE_VALIDITY_COMMITMENT)
// Then siloed = poseidon2_hash_with_separator([contract_address, validity_commitment], SILOED_NULLIFIER_SEPARATOR)

// Try to import poseidon2 and the constants
try {
  const { SILOED_NULLIFIER_SEPARATOR } = await import("@aztec/constants");

  console.log("\nStep 2: Computing expected nullifier hashes...");
  console.log(`  DOM_SEP for partial note validity: looking up...`);

  // The DOM_SEP__PARTIAL_NOTE_VALIDITY_COMMITMENT is a constant from the protocol
  // Let's find it
  const constants = await import("@aztec/constants");
  const constKeys = Object.keys(constants).filter(k => k.includes("PARTIAL") || k.includes("VALIDITY") || k.includes("DOM_SEP"));
  console.log(`  Relevant constants: ${constKeys.join(", ")}`);

  // Try to compute siloed nullifier
  console.log(`\n  SILOED_NULLIFIER_SEPARATOR: ${SILOED_NULLIFIER_SEPARATOR}`);

} catch (err) {
  console.log(`  Import error: ${String(err).substring(0, 200)}`);
}

// Step 3: Send prepare and get actual nullifiers
console.log("\nStep 3: Sending prepare tx...");
const receipt = await interaction.send({ from: alice, wait: { timeout: 120 }, ...feeOpts });
console.log(`  Tx mined: ${receipt.txHash}`);

const txEffect = await node.getTxEffect(receipt.txHash);
const nullifiers = getAztecTxEffectArray(txEffect, "nullifiers");
const nonZero = nullifiers.filter((n: unknown) => {
  const s = String(n);
  return s !== "0" && s !== "0x0" && !/^0x0+$/.test(s);
});

console.log(`\n  Actual nullifiers from prepare tx:`);
for (const n of nonZero) {
  console.log(`    ${String(n)}`);
}

// Step 4: Now simulate finalize to see what nullifier it looks for
console.log("\nStep 4: Simulating finalize to see what nullifier it computes...");
try {
  const finalizeInteraction = token.methods.transfer_private_to_commitment(
    alice,
    commitment,
    10000n,
    0,
  );
  const finalizeResult = await finalizeInteraction.simulate({ from: alice });
  console.log(`  Finalize simulate succeeded: ${String(finalizeResult)}`);
} catch (err) {
  const errStr = String(err);
  const nullifierMatch = errStr.match(/nullifier (0x[0-9a-f]+)/);
  const blockMatch = errStr.match(/block hash (0x[0-9a-f]+)/);
  if (nullifierMatch) {
    console.log(`  Finalize looks for nullifier: ${nullifierMatch[1]}`);
  }
  if (blockMatch) {
    console.log(`  At block hash: ${blockMatch[1]}`);
  }

  // Check if this nullifier is one of the prepare's
  if (nullifierMatch) {
    const lookingFor = nullifierMatch[1];
    const match = nonZero.find((n: unknown) => String(n) === lookingFor);
    if (match) {
      console.log(`  MATCH: This nullifier IS in the prepare tx ✓`);
    } else {
      console.log(`  MISMATCH: This nullifier is NOT in the prepare tx ✗`);
      console.log(`  Prepare nullifiers: ${nonZero.map((n: unknown) => String(n)).join(", ")}`);
    }
  }
}

console.log("\n=== Done ===");
process.exit(0);
