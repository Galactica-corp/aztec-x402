/**
 * Replay attack + load test — verifies that the same payment header
 * cannot be used twice, including under concurrent replay.
 *
 * Pays once sequentially (surfaces indexing lag as a payment failure),
 * then stamps a second prepared payment onto many unpaid resources.
 * Mutated headers must all fail.
 */
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { TokenContract } from "@aztec-foundation/aztec-standards/dist/src/artifacts/Token.js";
import { createPXEWallet } from "./pxe-wallet.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { ExactAztecClientScheme } from "@galactica-net/x402-mechanism/exact/client";
import { PaymentRequiredSchema, type ParsedPaymentRequirements } from "@galactica-net/x402-mechanism";
import { RealClientAztecSigner } from "./client-signer.js";
import { loadKeys, loadAccount, setupSponsoredPayment } from "./wallet-manager.js";

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:4402";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_CONCURRENCY = 10_000;

function parseConcurrency(raw: string | undefined): number {
  const value = raw ?? "100";
  if (!/^[1-9][0-9]*$/.test(value)) {
    console.error(`REPLAY_CONCURRENCY must be a positive integer, got ${JSON.stringify(raw)}`);
    process.exit(1);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_CONCURRENCY) {
    console.error(`REPLAY_CONCURRENCY must be a safe integer <= ${MAX_CONCURRENCY}, got ${value}`);
    process.exit(1);
  }
  return parsed;
}

const CONCURRENCY = parseConcurrency(process.env.REPLAY_CONCURRENCY);
const __dirname = dirname(new URL(import.meta.url).pathname);
const DATA_DIR = process.env.DATA_DIR ?? __dirname;
const CONFIG_PATH = join(DATA_DIR, "deploy.json");
const KEYS_PATH = join(DATA_DIR, "keys.json");
const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

const RUN_ID = crypto.randomUUID().slice(0, 8);
const NODE_URL = config.nodeUrl;
const isRemoteNetwork = config.network !== "aztec:sandbox";

const node = createAztecNodeClient(NODE_URL);
const wallet = await createPXEWallet(node, {
  ephemeral: true,
  pxe: { proverEnabled: isRemoteNetwork },
});

const keys = loadKeys(KEYS_PATH);
const aliceAccount = await loadAccount(wallet, keys, "alice");
const tokenAddress = AztecAddress.fromStringUnsafe(config.tokenAddress);
const tokenInstance = await node.getContract(tokenAddress);
if (tokenInstance) {
  await wallet.registerContract(tokenInstance, TokenContract.artifact);
}
const token = await TokenContract.at(tokenAddress, wallet);

const paymentMethod = isRemoteNetwork ? await setupSponsoredPayment(wallet) : undefined;
const feeOpts = paymentMethod ? { fee: { paymentMethod } } : undefined;
const clientSigner = new RealClientAztecSigner(aliceAccount, token, feeOpts);
const scheme = new ExactAztecClientScheme(clientSigner);

const senderAddress = await scheme.getSenderAddress?.();
if (!senderAddress) {
  console.error("client scheme did not expose a sender address");
  process.exit(1);
}

interface PaymentHeader {
  x402Version: number;
  accepted: ParsedPaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

interface BurstResult {
  path: string;
  label?: string;
  status: number;
  error?: string;
}

interface BurstTally {
  ok: number;
  paymentRequired: number;
  other: number;
}

function encodeHeader(header: PaymentHeader): string {
  return Buffer.from(JSON.stringify(header)).toString("base64");
}

function readError(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const errorValue = Reflect.get(body, "error");
  return errorValue == null ? undefined : String(errorValue);
}

async function burst(
  targets: { path: string; header: string; label?: string }[],
): Promise<BurstResult[]> {
  return Promise.all(
    targets.map(async ({ path, header, label }) => {
      try {
        const resp = await fetch(SERVER_URL + path, {
          headers: { "PAYMENT-SIGNATURE": header },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        let error: string | undefined;
        try {
          error = readError(await resp.json());
        } catch {
          // ignore non-JSON bodies
        }
        return { path, label, status: resp.status, error };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { path, label, status: 0, error: message };
      }
    }),
  );
}

function tally(results: BurstResult[]): BurstTally {
  const ok = results.filter((result) => result.status === 200).length;
  const paymentRequired = results.filter((result) => result.status === 402).length;
  return { ok, paymentRequired, other: results.length - ok - paymentRequired };
}

function printTally(title: string, results: BurstResult[]): BurstTally {
  const counts = tally(results);
  console.log(
    `  ${title}: ${counts.ok} x 200, ${counts.paymentRequired} x 402, ${counts.other} x other (n=${results.length})`,
  );
  for (const result of results) {
    if (result.status === 402) continue;
    const name = result.label ?? result.path;
    const reason = result.error ? ` (${result.error})` : "";
    console.log(`    ${name} -> ${result.status}${reason}`);
  }
  return counts;
}

function isReplayRejection(result: BurstResult): boolean {
  if (result.status !== 402) return false;
  const error = result.error ?? "";
  return (
    error.includes("payment already used") ||
    error.includes("already been consumed") ||
    error.includes("invalid or expired payment nonce") ||
    error.includes("payment verification in progress") ||
    error.includes("already being verified")
  );
}

function cloneHeader(header: PaymentHeader): PaymentHeader {
  return structuredClone(header);
}

function extraOf(header: PaymentHeader): Record<string, unknown> {
  const extra = Reflect.get(header.accepted, "extra");
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    return extra;
  }
  const created: Record<string, unknown> = {};
  Reflect.set(header.accepted, "extra", created);
  return created;
}

function cheapMutations(header: PaymentHeader): { label: string; header: string }[] {
  const encoded = encodeHeader(header);

  const droppedNonce = cloneHeader(header);
  Reflect.deleteProperty(extraOf(droppedNonce), "nonce");

  const replacedNonce = cloneHeader(header);
  Reflect.set(extraOf(replacedNonce), "nonce", crypto.randomUUID());

  return [
    { label: "truncated-base64", header: encoded.slice(0, Math.max(8, encoded.length - 8)) },
    { label: "dropped-nonce", header: encodeHeader(droppedNonce) },
    { label: "replaced-nonce", header: encodeHeader(replacedNonce) },
    { label: "empty-header", header: "" },
  ];
}

function flipTxHash(txHash: string): string {
  const hexIndex = txHash.startsWith("0x") ? 2 : 0;
  const flippedChar = txHash[hexIndex] === "0" ? "1" : "0";
  return txHash.slice(0, hexIndex) + flippedChar + txHash.slice(hexIndex + 1);
}

async function challengeAndPrepare(path: string): Promise<{
  x402Version: number;
  requirements: ParsedPaymentRequirements;
}> {
  const initialResp = await fetch(SERVER_URL + path, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payReqHeader = initialResp.headers.get("payment-required");
  if (!payReqHeader) {
    console.error(`No payment-required header from ${path}`);
    process.exit(1);
  }
  const paymentRequired = PaymentRequiredSchema.parse(
    JSON.parse(Buffer.from(payReqHeader, "base64").toString()),
  );
  const extra = paymentRequired.accepts[0].extra;
  const nonce = Reflect.get(extra, "nonce");
  const prepareData = Buffer.from(
    JSON.stringify({ nonce, senderAddress }),
  ).toString("base64");
  const prepareResp = await fetch(SERVER_URL + path, {
    headers: { "X-402-PREPARE": prepareData },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const preparedHeader = prepareResp.headers.get("payment-required");
  if (!preparedHeader) {
    console.error(`prepare phase returned no payment-required header for ${path}`);
    process.exit(1);
  }
  const prepared = PaymentRequiredSchema.parse(
    JSON.parse(Buffer.from(preparedHeader, "base64").toString()),
  );
  const requirements = prepared.accepts[0];
  const commitment = Reflect.get(requirements.extra, "commitment");
  if (!commitment) {
    console.error(`prepare phase returned no commitment for ${path}`);
    process.exit(1);
  }
  console.log(`  Commitment: ${String(commitment).slice(0, 20)}...`);
  return { x402Version: paymentRequired.x402Version, requirements };
}

async function createHeader(
  x402Version: number,
  requirements: ParsedPaymentRequirements,
): Promise<PaymentHeader> {
  const payloadResult = await scheme.createPaymentPayload(x402Version, requirements);
  return {
    x402Version: payloadResult.x402Version,
    accepted: requirements,
    payload: payloadResult.payload,
    extensions: payloadResult.extensions,
  };
}

console.log(`Concurrency: ${CONCURRENCY}`);
console.log(`Server: ${SERVER_URL}\n`);

// Sequential paid request first — indexing lag shows up here, not as a replay miss.
console.log("Step 1 — Sequential payment...");
const sequentialPath = `/api/weather/replay-${RUN_ID}-sequential`;
const sequentialPrepared = await challengeAndPrepare(sequentialPath);
const sequentialHeader = await createHeader(
  sequentialPrepared.x402Version,
  sequentialPrepared.requirements,
);
const sequentialResults = await burst([
  { path: sequentialPath, header: encodeHeader(sequentialHeader), label: "sequential" },
]);
printTally("sequential", sequentialResults);
if (sequentialResults[0]?.status !== 200) {
  console.error("Sequential payment did not return 200; not treating this as an anti-replay failure.");
  process.exit(1);
}

// Second prepared payment, then stampede that header.
console.log(`\nStep 2 — STAMPEDE (${CONCURRENCY} concurrent identical headers)...`);
const stampedePrepPath = `/api/weather/replay-${RUN_ID}-stampede-prep`;
const stampedePrepared = await challengeAndPrepare(stampedePrepPath);
const stampedeHeader = await createHeader(
  stampedePrepared.x402Version,
  stampedePrepared.requirements,
);
const stampedeEncoded = encodeHeader(stampedeHeader);
const stampedeResults = await burst(
  Array.from({ length: CONCURRENCY }, (_, i) => ({
    path: `/api/weather/replay-${RUN_ID}-stampede-${i}`,
    header: stampedeEncoded,
  })),
);
const stampedeTally = printTally("stampede", stampedeResults);
const stampedeReplayOk = stampedeResults.every(
  (result) => result.status === 200 || isReplayRejection(result),
);

console.log("\nStep 3 — FUZZ (mutated headers, concurrent)...");
const fuzzPrepPath = `/api/weather/replay-${RUN_ID}-fuzz-prep`;
const fuzzPrepared = await challengeAndPrepare(fuzzPrepPath);
const flipped = cloneHeader(stampedeHeader);
flipped.accepted = fuzzPrepared.requirements;
const originalTxHash = String(Reflect.get(stampedeHeader.payload, "txHash") ?? "0x00");
Reflect.set(flipped.payload, "txHash", flipTxHash(originalTxHash));

const fuzzTargets = [
  ...cheapMutations(stampedeHeader).map((mutation, i) => ({
    path: `/api/weather/replay-${RUN_ID}-fuzz-${i}`,
    header: mutation.header,
    label: mutation.label,
  })),
  {
    path: `/api/weather/replay-${RUN_ID}-fuzz-txhash`,
    header: encodeHeader(flipped),
    label: "flipped-txHash",
  },
];
const fuzzResults = await burst(fuzzTargets);
const fuzzTally = printTally("fuzz", fuzzResults);

const passed =
  stampedeTally.ok === 1 &&
  stampedeTally.other === 0 &&
  stampedeReplayOk &&
  fuzzTally.ok === 0 &&
  fuzzTally.other === 0;

if (passed) {
  console.log("\nAnti-replay protection works under load");
  console.log(
    `   stampede ${stampedeTally.ok}/${CONCURRENCY} succeeded, fuzz ${fuzzTally.ok} succeeded`,
  );
  process.exit(0);
}

console.log("\nAnti-replay protection FAILED under load");
if (stampedeTally.ok !== 1) {
  console.log(`   expected exactly 1 stampede success, got ${stampedeTally.ok}`);
}
if (stampedeTally.other !== 0 || !stampedeReplayOk) {
  console.log("   stampede non-winners must be 402 with a replay reason");
}
if (fuzzTally.ok !== 0 || fuzzTally.other !== 0) {
  console.log(`   expected 0 fuzz successes and 0 non-402s, got ${fuzzTally.ok} / ${fuzzTally.other}`);
}
process.exit(1);
