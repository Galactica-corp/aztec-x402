/**
 * End-to-end check of the token in deploy.json on a local network, for either
 * kind: a request is opened, paid and verified through the same signers the
 * server and the agent use, and the token's own rules refuse what they should.
 *
 * Prerequisites: a local network and `bun run setup:sandbox` (AIP-20) or
 * `bun run setup:sandbox:inference` (inference-money USDC).
 *
 * Usage: bun run packages/demo/src/aztec/sandbox-e2e.ts
 */
import { createNodeClient, TokenRegistry } from "@galactica-net/x402-agent/aztec";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { RealClientAztecSigner } from "./client-signer.js";
import { RealFacilitatorAztecSigner } from "./facilitator-signer.js";
import { shouldEnableProver } from "./network-config.js";
import { loadKeys, loadAccount, openDemoWallet, setupSponsoredPayment } from "./wallet-manager.js";

const AMOUNT = 10_000n;

const __dirname = dirname(new URL(import.meta.url).pathname);
const DATA_DIR = process.env.DATA_DIR ?? __dirname;
const config = JSON.parse(readFileSync(join(DATA_DIR, "deploy.json"), "utf-8"));
const TOKEN: string = config.tokenAddress;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** The error code a refused call reports, or "no error" if it went through. */
async function refusal(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "no error";
  } catch (error) {
    const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
    return typeof code === "string" ? code : String(error);
  }
}

const node = createNodeClient(config.nodeUrl);
const { wallet, paymentGate } = await openDemoWallet(node, shouldEnableProver(config.network), TOKEN);
const keys = loadKeys(join(DATA_DIR, "keys.json"));
const payer = await loadAccount(wallet, keys, "alice");
const merchant = await loadAccount(wallet, keys, "bob");
await wallet.registerSender(merchant.address, "bob");
await wallet.registerSender(payer.address, "alice");
const fee = { paymentMethod: await setupSponsoredPayment(wallet) };

// One wallet holds both accounts; each side gets its own view of the token.
const merchantTokens = new TokenRegistry({ node, wallet, account: merchant.address, fee });
const payerTokens = new TokenRegistry({ node, wallet, account: payer.address, fee, paymentGate });
const facilitator = new RealFacilitatorAztecSigner(merchant, node, merchantTokens);
const client = new RealClientAztecSigner(payer, payerTokens);
const payerToken = await payerTokens.get(TOKEN);
console.log(`Token ${TOKEN} is ${payerToken.kind}\n`);

await facilitator.assertCanSell(TOKEN);
await payerToken.preflight(merchant.address);
check("merchant can sell, payer may pay it", true);

const before = await payerToken.privateBalance();
const prepared = await facilitator.prepareCommitment(TOKEN, payer.address.toString());
if (prepared.offchainMessage && prepared.prepareTxHash) {
  await client.processOffchainMessage(TOKEN, prepared.offchainMessage, prepared.prepareTxHash);
}
const txHash = await client.finalizePayment(TOKEN, prepared.commitment, AMOUNT);
const verified = await facilitator.verifyPayment(txHash, TOKEN, AMOUNT, prepared.commitment);
check("payment is verified by its completion log", verified.isValid && verified.amountFound === AMOUNT, verified.error);
const spent = before - (await payerToken.privateBalance());
check("payer's balance fell by the amount", spent === AMOUNT, `spent ${spent}`);

const tooMuch = await facilitator.verifyPayment(txHash, TOKEN, AMOUNT + 1n, prepared.commitment);
check("a higher required amount is not met", !tooMuch.isValid);

if (payerToken.kind === "inference-money") {
  // The payer is a user, not a listed merchant: it can neither sell nor be paid by another user.
  const asSeller = new RealFacilitatorAztecSigner(payer, node, payerTokens);
  const cannotSell = await refusal(() => asSeller.assertCanSell(TOKEN));
  check("an unlisted account cannot sell", cannotSell === "merchant_not_listed", cannotSell);

  const cannotOpen = await refusal(() => asSeller.prepareCommitment(TOKEN, merchant.address.toString()));
  check("and its request is refused before anything is proven", cannotOpen === "token_refused", cannotOpen);

  const unlistedPayee = await refusal(() => payerToken.preflight(payer.address));
  check("a payment to an unlisted payee is refused up front", unlistedPayee === "merchant_not_listed", unlistedPayee);

  const second = await refusal(() => client.finalizePayment(TOKEN, prepared.commitment, AMOUNT));
  check("a second payment into one request is refused before proving", second === "payment_refused", second);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
