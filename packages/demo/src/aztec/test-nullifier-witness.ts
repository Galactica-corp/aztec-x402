/**
 * Minimal test: Can the sandbox node return a nullifier membership witness?
 *
 * This checks:
 * 1. Deploy a tx and get its nullifiers from txEffect
 * 2. Query the node for a nullifier membership witness for those nullifiers
 * 3. See if the node can actually find them
 */
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { BlockNumber } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { TokenContract } from "@defi-wonderland/aztec-standards/dist/src/artifacts/Token.js";
import { getAztecTxEffectArray, unwrapAztecSdkResult } from "@galactica-net/x402-core";
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
const isRemoteNetwork = process.env.USE_SPONSORED_FPC === "true" || NETWORK !== "aztec:sandbox";

function toFr(value: unknown): Fr {
  return value instanceof Fr ? value : new Fr(BigInt(String(value)));
}

console.log("=== Nullifier Witness Test ===\n");

const node = createAztecNodeClient(NODE_URL);
const wallet = await createPXEWallet(node, {
  ephemeral: true,
  pxe: { proverEnabled: isRemoteNetwork },
});

const keys = loadKeys(KEYS_PATH);
const aliceAccount = await loadAccount(wallet, keys, "alice");
const alice = aliceAccount.address;

const tokenAddress = AztecAddress.fromStringUnsafe(config.tokenAddress);
const tokenInstance = await node.getContract(tokenAddress);
if (tokenInstance) {
  await wallet.registerContract(tokenInstance, TokenContract.artifact);
}
const token = await TokenContract.at(tokenAddress, wallet);

await wallet.registerSender(alice, "alice");

const paymentMethod = isRemoteNetwork ? await setupSponsoredPayment(wallet) : undefined;
const feeOpts = paymentMethod ? { fee: { paymentMethod } } : {};

// Step 1: Do a prepare call to create a nullifier
console.log("Step 1: Alice calls initialize_transfer_commitment(alice, alice)...");
const interaction = token.methods.initialize_transfer_commitment(alice, alice);
const simResult = await interaction.simulate({ from: alice });
const commitment = unwrapAztecSdkResult(simResult);
console.log(`  Commitment: ${String(commitment)}`);

// v5: a waited send resolves to { receipt, ... } — the tx hash is on the receipt.
const { receipt } = await interaction.send({ from: alice, wait: { timeout: 120 }, ...feeOpts });
console.log(`  Tx mined: ${receipt.txHash}`);

// Step 2: Get the tx effect and extract nullifiers
const txEffect = await node.getTxEffect(receipt.txHash);
if (!txEffect) {
  console.error("No tx effect found!");
  process.exit(1);
}

const nullifiers = getAztecTxEffectArray(txEffect, "nullifiers");
const nonZero = nullifiers.filter((n: unknown) => {
  const s = String(n);
  return s !== "0" && s !== "0x0" && !/^0x0+$/.test(s);
});

console.log(`\nStep 2: Prepare tx nullifiers (${nonZero.length}):`);
for (const n of nonZero) {
  console.log(`  ${String(n)}`);
}

// Step 3: Get block info
const txReceipt = await node.getTxReceipt(receipt.txHash);
// v5 receipts are a lifecycle union — block fields only exist once mined.
if (!txReceipt.isMined()) {
  console.error(`Tx is not mined (status ${txReceipt.status})!`);
  process.exit(1);
}
const blockNumber = txReceipt.blockNumber;
console.log(`\n  Block number: ${blockNumber}`);

// Step 4: Try to get nullifier membership witness from node
console.log("\nStep 3: Query node for nullifier membership witnesses...");

// v5 unified the block lookups into getBlock, whose response carries the hash.
const block = await node.getBlock(blockNumber);
if (!block) {
  console.error("No block found!");
  process.exit(1);
}

const blockHash = block.hash;
console.log(`  Block hash: ${blockHash}`);

for (const n of nonZero) {
  try {
    const witness = await node.getNullifierMembershipWitness(blockHash, toFr(n));
    if (witness) {
      console.log(`  Nullifier ${String(n).substring(0, 20)}...: FOUND ✓`);
      console.log(`    Leaf preimage nullifier: ${witness.leafPreimage?.leaf.nullifier}`);
    } else {
      console.log(`  Nullifier ${String(n).substring(0, 20)}...: NOT FOUND ✗`);
    }
  } catch (err) {
    console.log(`  Nullifier ${String(n).substring(0, 20)}...: ERROR - ${String(err).substring(0, 100)}`);
  }
}

// Step 5: Also try previous block
if (blockNumber > 1) {
  const prevBlock = await node.getBlock(BlockNumber.add(blockNumber, -1));
  if (prevBlock) {
    const prevHash = prevBlock.hash;
    console.log(`\n  Previous block (${blockNumber - 1}) hash: ${prevHash}`);
    for (const n of nonZero) {
      try {
        const witness = await node.getNullifierMembershipWitness(prevHash, toFr(n));
        if (witness) {
          console.log(`  Nullifier ${String(n).substring(0, 20)}...: FOUND at prev block ✓`);
        } else {
          console.log(`  Nullifier ${String(n).substring(0, 20)}...: NOT FOUND at prev block (expected)`);
        }
      } catch {
        console.log(`  Nullifier ${String(n).substring(0, 20)}...: ERROR at prev block`);
      }
    }
  }
}

console.log("\n=== Done ===");
process.exit(0);
