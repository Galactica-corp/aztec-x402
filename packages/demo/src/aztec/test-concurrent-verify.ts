/**
 * Concurrent verifyPayment test.
 *
 * Exercises the commitment-tagged completion-log lookup in
 * RealFacilitatorAztecSigner.verifyPayment by running two prepare + finalize
 * flows concurrently and then verifying both with the same facilitator
 * instance.
 *
 * Prerequisites: run `bun run setup` first to deploy accounts + the token
 * contract on the configured Aztec node, and mint some balance to Alice.
 *
 * Usage:
 *   bun run packages/demo/src/aztec/test-concurrent-verify.ts
 */
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { TokenContract } from "@defi-wonderland/aztec-standards/dist/src/artifacts/Token.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { createPXEWallet } from "./pxe-wallet.js";
import { loadKeys, loadAccount, setupSponsoredPayment } from "./wallet-manager.js";
import { RealFacilitatorAztecSigner } from "./facilitator-signer.js";
import { RealClientAztecSigner } from "./client-signer.js";

const USE_SPONSORED_FPC = process.env.USE_SPONSORED_FPC === "true";

const __dirname = dirname(new URL(import.meta.url).pathname);
const DATA_DIR = process.env.DATA_DIR ?? __dirname;
const CONFIG_PATH = join(DATA_DIR, "deploy.json");
const KEYS_PATH = join(DATA_DIR, "keys.json");

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
const NODE_URL = config.nodeUrl as string;
const NETWORK = config.network as string;
const TOKEN_ADDRESS = config.tokenAddress as string;
const isDevnet = NETWORK !== "aztec:sandbox";

// Two distinct amounts so we can verify they aren't conflated.
const AMOUNT_A = 11_111n;
const AMOUNT_B = 22_222n;

console.log("=== Concurrent verifyPayment test ===\n");
console.log(`Node: ${NODE_URL}`);
console.log(`Token: ${TOKEN_ADDRESS}\n`);

console.log("Connecting...");
const node = createAztecNodeClient(NODE_URL);
const wallet = await createPXEWallet(node, {
  ephemeral: true,
  pxeConfig: { proverEnabled: isDevnet },
});

const paymentMethod = USE_SPONSORED_FPC ? await setupSponsoredPayment(wallet) : undefined;
const sendOpts = paymentMethod ? { fee: { paymentMethod } } : undefined;

const keys = loadKeys(KEYS_PATH);
const aliceAccount = await loadAccount(wallet, keys, "alice"); // buyer
const bobAccount = await loadAccount(wallet, keys, "bob"); // facilitator
const alice = aliceAccount.address;
const bob = bobAccount.address;
console.log(`Alice (buyer):       ${alice}`);
console.log(`Bob   (facilitator): ${bob}\n`);

const tokenAddress = AztecAddress.fromString(TOKEN_ADDRESS);
const tokenInstance = await node.getContract(tokenAddress);
if (tokenInstance) {
  await wallet.registerContract(tokenInstance, TokenContract.artifact);
}
await wallet.registerSender(bob, "bob");
await wallet.registerSender(alice, "alice");
const token = await TokenContract.at(tokenAddress, wallet);

const facilitatorSigner = new RealFacilitatorAztecSigner(bobAccount, node, token, sendOpts);
const clientSigner = new RealClientAztecSigner(aliceAccount, token, sendOpts);

interface FlowResult {
  label: string;
  amount: bigint;
  commitment: string;
  finalizeTxHash: string;
  offchainMessage?: string;
}

async function runFlow(label: string, amount: bigint): Promise<FlowResult> {
  console.log(`[${label}] prepareCommitment(amount=${amount})...`);
  const prepared = await facilitatorSigner.prepareCommitment(
    TOKEN_ADDRESS,
    alice.toString(),
  );
  const prepareTxHash = prepared.prepareTxHash;
  if (!prepareTxHash) {
    throw new Error(`[${label}] prepareCommitment did not return a prepareTxHash`);
  }
  console.log(`[${label}]   commitment:       ${prepared.commitment}`);
  console.log(`[${label}]   prepareTxHash:    ${prepareTxHash}`);

  if (prepared.offchainMessage) {
    await clientSigner.processOffchainMessage(
      TOKEN_ADDRESS,
      prepared.offchainMessage,
      prepareTxHash,
    );
  }

  console.log(`[${label}] finalizePayment(amount=${amount})...`);
  const finalizeTxHash = await clientSigner.finalizePayment(
    TOKEN_ADDRESS,
    prepared.commitment,
    amount,
  );
  console.log(`[${label}]   finalizeTxHash:   ${finalizeTxHash}`);

  return {
    label,
    amount,
    commitment: prepared.commitment,
    finalizeTxHash,
    offchainMessage: prepared.offchainMessage,
  };
}

console.log("--- Running two prepare+finalize flows concurrently ---\n");
const [flowA, flowB] = await Promise.all([
  runFlow("A", AMOUNT_A),
  runFlow("B", AMOUNT_B),
]);
console.log("");

if (flowA.commitment === flowB.commitment) {
  console.error("❌ flowA and flowB produced the same commitment — test setup is broken");
  process.exit(1);
}

let failures = 0;

async function expectValid(flow: FlowResult): Promise<void> {
  console.log(`[verify ${flow.label}] verifyPayment(txHash=${flow.finalizeTxHash}, commitment=${flow.commitment})`);
  const result = await facilitatorSigner.verifyPayment(
    flow.finalizeTxHash,
    TOKEN_ADDRESS,
    flow.amount,
    flow.commitment,
  );
  if (!result.isValid) {
    console.error(`  ❌ expected valid, got error: ${result.error}`);
    failures += 1;
    return;
  }
  if (result.amountFound !== flow.amount) {
    console.error(`  ❌ expected amountFound=${flow.amount}, got ${result.amountFound}`);
    failures += 1;
    return;
  }
  console.log(`  ✓ valid, amountFound=${result.amountFound}`);
}

async function expectInvalid(
  label: string,
  txHash: string,
  commitment: string,
  amount: bigint,
  errorMatcher: RegExp,
): Promise<void> {
  console.log(`[verify ${label}] verifyPayment(txHash=${txHash}, commitment=${commitment}) — expecting rejection`);
  const result = await facilitatorSigner.verifyPayment(
    txHash,
    TOKEN_ADDRESS,
    amount,
    commitment,
  );
  if (result.isValid) {
    console.error(`  ❌ expected rejection, got valid result (amountFound=${result.amountFound})`);
    failures += 1;
    return;
  }
  if (!result.error || !errorMatcher.test(result.error)) {
    console.error(`  ❌ expected error to match ${errorMatcher}, got: ${result.error}`);
    failures += 1;
    return;
  }
  console.log(`  ✓ rejected: ${result.error}`);
}

console.log("\n--- Positive cases: both flows must verify independently ---\n");
await expectValid(flowA);
await expectValid(flowB);

console.log("\n--- Negative case: swap commitment between flows ---\n");
// flowA.txHash with flowB.commitment must be rejected because the log keyed by
// flowB.commitment belongs to flowB's tx, not flowA's tx.
await expectInvalid(
  "A-tx + B-commitment",
  flowA.finalizeTxHash,
  flowB.commitment,
  flowA.amount,
  /completion log belongs to tx/,
);

console.log("\n--- Negative case: insufficient amount ---\n");
// flowA's commitment+tx are valid but we require a higher amount than was paid.
await expectInvalid(
  "A-insufficient",
  flowA.finalizeTxHash,
  flowA.commitment,
  AMOUNT_A + 1n,
  /insufficient payment/,
);

console.log("\n--- Negative case: unknown commitment ---\n");
// 0x1 is structurally a non-zero field but no completion log exists for it.
await expectInvalid(
  "A-unknown-commitment",
  flowA.finalizeTxHash,
  "0x0000000000000000000000000000000000000000000000000000000000000001",
  flowA.amount,
  /no completion log found for commitment/,
);

if (failures > 0) {
  console.error(`\n❌ ${failures} assertion(s) failed`);
  process.exit(1);
}

console.log("\n✅ All concurrent verifyPayment cases passed.");
process.exit(0);
