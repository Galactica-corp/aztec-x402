/**
 * Standalone test for v4.1.0 offchain partial note delivery.
 *
 * Uses the OFFICIAL Aztec v4.1.0 TokenContract and sandbox pre-deployed test accounts
 * to avoid ABI/deployment compatibility issues.
 *
 * Tests:
 * 1. Deploy official token contract + mint tokens
 * 2. Call prepare_private_balance_increase (official token) and check if send() returns offchainMessages
 * 3. Test transfer_to_private as the completion path
 *
 * Usage: NODE_URL=http://localhost:8080 bun run packages/demo/src/aztec/test-offchain-partial.ts
 *
 * Prerequisites: Aztec sandbox running v4.1.0-nightly on localhost:8080
 */
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { Fr } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { TokenContract, TokenContractArtifact } from "@aztec/noir-contracts.js/Token";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { getContractInstanceFromInstantiationParams } from "@aztec/aztec.js/contracts";
import { TxHash } from "@aztec/aztec.js/tx";
import { INITIAL_TEST_SECRET_KEYS, INITIAL_TEST_SIGNING_KEYS, INITIAL_TEST_ACCOUNT_SALTS } from "@aztec/accounts/testing";
import { SponsoredFPCContractArtifact } from "@aztec/noir-contracts.js/SponsoredFPC";
import { SPONSORED_FPC_SALT } from "@aztec/constants";
import { createPXEWallet } from "./pxe-wallet.js";
import { z } from "zod";

const NODE_URL = process.env.NODE_URL ?? "http://localhost:8080";
const MINT_AMOUNT = 1_000_000n;
const TRANSFER_AMOUNT = 10_000n;

const UnknownRecordSchema = z.record(z.string(), z.unknown());

function parseRecord(value: unknown): Record<string, unknown> {
  const parsed = UnknownRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function getObjectProperty(value: unknown, key: string): unknown {
  return parseRecord(value)[key];
}

function getKeys(value: unknown): string[] {
  return Object.keys(parseRecord(value));
}

function getEntries(value: unknown): Array<[string, unknown]> {
  return Object.entries(parseRecord(value));
}

function getArrayProperty(value: unknown, key: string): unknown[] {
  const prop = getObjectProperty(value, key);
  return Array.isArray(prop) ? prop : [];
}

function getConstructorName(value: unknown): string | undefined {
  return value != null && typeof value === "object"
    ? value.constructor?.name
    : undefined;
}

console.log("=== v4.1.0 Offchain Partial Note Delivery Test ===\n");
console.log(`Node: ${NODE_URL}`);

// 1. Connect
console.log("Connecting...");
const node = createAztecNodeClient(NODE_URL);
const info = await node.getNodeInfo();
console.log(`Node version: ${info.nodeVersion}\n`);

const wallet = await createPXEWallet(node, {
  ephemeral: true,
  pxe: { proverEnabled: true },
});

// Set up sponsored fee payment
const sponsoredFPC = await getContractInstanceFromInstantiationParams(
  SponsoredFPCContractArtifact,
  { salt: new Fr(SPONSORED_FPC_SALT) },
);
await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact);
const paymentMethod = new SponsoredFeePaymentMethod(sponsoredFPC.address);
console.log("Using Sponsored FPC for fees.\n");

// 2. Load pre-deployed test accounts from sandbox
console.log("Loading sandbox test accounts...");
const aliceAccount = await wallet.createSchnorrAccount(
  INITIAL_TEST_SECRET_KEYS[0],
  INITIAL_TEST_ACCOUNT_SALTS[0],
  INITIAL_TEST_SIGNING_KEYS[0],
);
const bobAccount = await wallet.createSchnorrAccount(
  INITIAL_TEST_SECRET_KEYS[1],
  INITIAL_TEST_ACCOUNT_SALTS[1],
  INITIAL_TEST_SIGNING_KEYS[1],
);
const alice = aliceAccount.address;
const bob = bobAccount.address;
console.log(`Alice: ${alice}`);
console.log(`Bob:   ${bob}\n`);

const sendOpts = (from: AztecAddress) => ({
  from,
  wait: { timeout: 120 },
  fee: { paymentMethod },
});

// 3. Deploy official v4.1.0 token contract
console.log("Deploying official v4.1.0 TokenContract...");
const tokenDeploy = TokenContract.deploy(wallet, alice, "TestUSD", "tUSD", 6);
const deployResult = await tokenDeploy.send(sendOpts(alice));
// v5: getInstance() is async.
const tokenAddress = (await tokenDeploy.getInstance())?.address;
if (!tokenAddress) {
  console.log(`  deployResult keys: ${getKeys(deployResult)}`);
  console.error("Could not get token address");
  process.exit(1);
}
// v4.1.0 confirmation: send() returns { contract, receipt, offchainEffects, offchainMessages }
console.log(`  send() returned keys: ${getKeys(deployResult)}`);
console.log(`Token: ${tokenAddress}\n`);

// Register contract
const tokenInstance = await node.getContract(tokenAddress);
if (tokenInstance) {
  await wallet.registerContract(tokenInstance, TokenContractArtifact);
}
const token = await TokenContract.at(tokenAddress, wallet);

// Register senders
await wallet.registerSender(bob, "bob");
await wallet.registerSender(alice, "alice");

// 4. Mint tokens to Alice
console.log(`Minting ${MINT_AMOUNT} to Alice...`);
try {
  const mintResult = await token.methods.mint_to_private(alice, MINT_AMOUNT).send(sendOpts(alice));
  console.log(`  Minted. send() keys: ${getKeys(mintResult)}`);
} catch (err) {
  console.log(`  Mint failed: ${String(err).slice(0, 200)}`);
  console.log("  Trying public mint + transfer instead...");
  try {
    // Try minting publicly then transferring to private
    const mintToPublic = getObjectProperty(token.methods, "mint_to_public");
    if (typeof mintToPublic !== "function") {
      throw new Error("mint_to_public is not available on this token contract");
    }
    await mintToPublic.call(token.methods, alice, MINT_AMOUNT).send(sendOpts(alice));
    console.log("  Public mint succeeded.");
    await token.methods.transfer_to_private(alice, MINT_AMOUNT).send(sendOpts(alice));
    console.log("  Transferred to private.");
  } catch (err2) {
    console.log(`  Public mint also failed: ${String(err2).slice(0, 200)}`);
    console.log("  Continuing without balance — will test anyway...");
  }
}

// Check balance
try {
  const balanceBefore = await token.methods.balance_of_private(alice).simulate({ from: alice });
  console.log(`Alice balance: ${balanceBefore}\n`);
} catch {
  console.log("  Balance check failed (expected if minting failed)\n");
}

// 5. TEST: prepare_private_balance_increase — check for offchainMessages
console.log("=== Test 1: prepare_private_balance_increase — check send() result ===\n");

const interaction = token.methods.prepare_private_balance_increase(bob);
const simResult = await interaction.simulate({ from: alice });
console.log(`simulate() result: ${JSON.stringify(simResult, (_, v) => typeof v === "bigint" ? v.toString() : v)}`);

const sendResult = await interaction.send(sendOpts(alice));
console.log(`\nsend() result keys: ${getKeys(sendResult)}`);
console.log(`send() txHash: ${getObjectProperty(sendResult, "txHash")}`);

// Check for offchainMessages
const offchainMessages = getArrayProperty(sendResult, "offchainMessages");
if (offchainMessages.length > 0) {
  const msgs = offchainMessages;
  console.log(`\n✓ offchainMessages found! Count: ${msgs.length}`);
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    console.log(`  Message ${i}:`);
    for (const [k, v] of getEntries(msg)) {
      const valStr = typeof v === "string" && v.length > 100 ? v.slice(0, 100) + "..." : String(v);
      console.log(`    ${k}: ${valStr}`);
    }
  }

  // Compare with simulate
  let simCommitment: string;
  if (simResult != null && typeof simResult === "object" && "commitment" in simResult) {
    simCommitment = String(simResult.commitment);
  } else {
    simCommitment = String(simResult);
  }
  console.log(`\n  simulate() commitment: ${simCommitment}`);
} else {
  console.log("\n✗ No offchainMessages in send() result");

  // Inspect full result shape
  console.log("\n  Full send() result:");
  for (const [key, val] of getEntries(sendResult)) {
    if (typeof val === "object" && val !== null) {
      console.log(`    ${key}: [${getConstructorName(val)}] keys: ${getKeys(val).slice(0, 10)}`);
    } else {
      console.log(`    ${key}: ${String(val).slice(0, 80)}`);
    }
  }
}

// 6. List all token methods — check for offchain-related
console.log("\n=== Token contract methods ===");
const methods = getKeys(getObjectProperty(token, "methods"));
console.log(methods.join(", "));

const offchainMethods = methods.filter(m => m.toLowerCase().includes("offchain"));
if (offchainMethods.length > 0) {
  console.log(`\n✓ Offchain methods: ${offchainMethods.join(", ")}`);
} else {
  console.log("\n  No offchain-specific methods on official token");
}

// 7. Test transfer_to_private
console.log("\n=== Test 2: transfer_to_private ===\n");
try {
  const transferResult = await token.methods.transfer_to_private(bob, TRANSFER_AMOUNT).send(sendOpts(alice));
  console.log(`send() keys: ${getKeys(transferResult)}`);

  if (getArrayProperty(transferResult, "offchainMessages").length > 0) {
    console.log("✓ offchainMessages on transfer_to_private!");
  } else {
    console.log("  No offchainMessages on transfer_to_private");
    // Check receipt
    for (const [key, val] of getEntries(transferResult)) {
      if (typeof val === "object" && val !== null) {
        console.log(`    ${key}: [${getConstructorName(val)}] keys: ${getKeys(val).slice(0, 10)}`);
      } else {
        console.log(`    ${key}: ${String(val).slice(0, 80)}`);
      }
    }
  }

  // Check on-chain
  const txHash = getObjectProperty(transferResult, "txHash");
  if (txHash) {
    const receipt = await node.getTxReceipt(TxHash.fromString(String(txHash)));
    console.log(`Tx status: ${receipt.status}`);
  }
} catch (err) {
  console.error(`transfer_to_private failed: ${err}`);
}

const balanceAfter = await token.methods.balance_of_private(alice).simulate({ from: alice });
console.log(`\nAlice balance after: ${balanceAfter}`);

console.log("\n=== Test Complete ===\n");
process.exit(0);
