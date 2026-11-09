/**
 * End-to-end check of split payments (one Ethereum deposit pays the merchant)
 * against the inference-money USDC in deploy.json, through the same merchant
 * stack the server runs (SplitMerchant, MerchantJobs, SQLite store):
 *
 * 1. The buyer deposits a round amount on L1 for the merchant's terms.
 * 2. The merchant refuses it while unconfirmed, accepts it once deep enough,
 *    and refuses it for another price or another merchant.
 * 3. The claim job claims it on Aztec; the merchant is paid the price.
 * 4. The buyer collects the change into its own Aztec account; a buyer bound
 *    to another Ethereum address is refused (it would have to return it).
 * 5. A deposit made before a merchant's listing landed is refused.
 *
 * Local network: `bun run setup:sandbox:inference`, then this script. It
 * mines L1 blocks and lists a throwaway merchant, so it is local-only.
 *
 * Usage: bun run packages/demo/src/aztec/split-e2e.ts
 */
import { mkdirSync, readFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { createNodeClient } from "@galactica-net/x402-agent/aztec";
import {
  NotFundingAddressError,
  changeOf,
  changeState,
  claimChange,
  l2UsdcBalance,
  parseManifest,
  registerSponsor,
  signingKeyFor,
  syncMerchantList,
  type MerchantList,
} from "@galactica-net/inference-money-core";
import { addMerchants, BRIDGE_EVM_ARTIFACTS, l1Signer, startBlockHeartbeat, writeEvm } from "@galactica-net/inference-money-core/deploy";
import { derivePaymentRef } from "@galactica-net/x402-middleware";
import { randomBytes } from "crypto";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { mnemonicToAccount } from "viem/accounts";
import { openMerchant } from "./merchant.js";
import { createPXEWallet } from "./pxe-wallet.js";
import { ANVIL_ACCOUNT_INDEX, ANVIL_MNEMONIC, LOCAL_ADMIN_SECRET } from "./setup-inference.js";
import { paySplit } from "./split-buyer.js";
import { loadAccount, loadKeys, setupSponsoredPayment } from "./wallet-manager.js";

const PRICE = 370_000n;

const __dirname = dirname(new URL(import.meta.url).pathname);
const DATA_DIR = process.env.DATA_DIR ?? __dirname;
const config = JSON.parse(readFileSync(join(DATA_DIR, "deploy.json"), "utf-8"));
if (!config.manifestPath || !config.l1RpcUrl) throw new Error("deploy.json has no local bridge: run `bun run setup:sandbox:inference` first.");
const m = parseManifest(JSON.parse(readFileSync(config.manifestPath, "utf-8")));

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const node = createNodeClient(config.nodeUrl);
const wallet = await createPXEWallet(node, { ephemeral: true, pxe: { proverEnabled: false } });
const keys = loadKeys(join(DATA_DIR, "keys.json"));
const buyer = await loadAccount(wallet, keys, "alice");
const seller = await loadAccount(wallet, keys, "bob");
const fee = { paymentMethod: await setupSponsoredPayment(wallet) };
const stateDir = join(DATA_DIR, "split-e2e");
rmSync(stateDir, { recursive: true, force: true });
mkdirSync(stateDir, { recursive: true });
const merchant = await openMerchant({
  config: { network: config.network, tokenAddress: config.tokenAddress, l1RpcUrl: config.l1RpcUrl, manifestPath: config.manifestPath },
  dataDir: stateDir,
  node,
  wallet,
  account: seller,
  fee,
  log: (msg) => console.log(`      [merchant] ${msg}`),
});
const split = merchant.split;
if (!split) throw new Error("split payments are off for this merchant");

// The setup's funding key (bound to the buyer) and a second one (not bound to it).
const chainId = m.l1.chainId;
const boundKey = l1Signer(config.l1RpcUrl, chainId, mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: ANVIL_ACCOUNT_INDEX }));
const otherKey = l1Signer(config.l1RpcUrl, chainId, mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: ANVIL_ACCOUNT_INDEX - 1 }));
for (const k of [boundKey, otherKey]) {
  await writeEvm(k, "MockUsdc mint", m.l1.usdc, BRIDGE_EVM_ARTIFACTS.mockUsdc.abi, "mint", [k.account.address, 20_000_000n]);
}
const mine = async (blocks = 1) => {
  for (let i = 0; i < blocks; i++) {
    await fetch(config.l1RpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "evm_mine", params: [] }),
    });
  }
};

// A local network builds a block only when a tx arrives: keep it moving so L1 messages land.
const beater = await createPXEWallet(node, { ephemeral: true, pxe: { proverEnabled: false } });
await registerSponsor(beater, m);
const stopHeartbeat = await startBlockHeartbeat(beater, m);

async function terms(nonce = crypto.randomUUID()) {
  const t = await split.terms(PRICE);
  if (!t) throw new Error("the merchant offers no split terms");
  const paymentRef = derivePaymentRef(merchant.secret, { nonce, network: config.network, asset: config.tokenAddress, payTo: seller.address.toString(), price: PRICE.toString() });
  return { ...t, paymentRef };
}

async function claimed(ref: string, claim: string): Promise<string> {
  const now = Date.now();
  await merchant.store.saveSplitClaim({ paymentRef: ref, asset: config.tokenAddress, claim, status: "pending", attempts: 0, nextTryAt: now, updatedAt: now });
  const started = Date.now();
  for (let i = 0; i < 120; i++) {
    await merchant.store.updateSplitClaim(ref, { nextTryAt: 0 });
    await merchant.jobs.claimDue();
    const c = (await merchant.store.splitClaims()).find((x) => x.paymentRef === ref);
    if (c && c.status !== "pending") {
      console.log(`      claimed after ${Math.round((Date.now() - started) / 1000)}s, ${c.attempts} attempts`);
      return c.status;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return "pending";
}

try {
  const t = await terms();
  check("the merchant offers split terms on this bridge", t.portal.toLowerCase() === m.l1.portal.toLowerCase() && t.denominations.includes("1000000"));

  const merchantBefore = await l2UsdcBalance(wallet, m, seller.address, "private");
  const buyerBefore = await l2UsdcBalance(wallet, m, buyer.address, "private");
  const paid = await paySplit({ l1: boundKey, m, node, terms: t, buyer: buyer.address });
  check("the buyer deposits the smallest round amount, not the price", paid.amount === 1_000_000n, `${paid.amount}`);

  const expected = { paymentRef: t.paymentRef, price: PRICE };
  // The local L1 keeps mining on its own, so "not deep enough" is staged with a merchant that wants many blocks.
  const { SplitMerchant } = await import("@galactica-net/x402-agent/aztec");
  const strict = await SplitMerchant.create({ manifest: m, l1: boundKey.publicClient, node, wallet, merchant: seller.address, confirmations: 10_000 });
  const early = await strict.verify(paid.proof, expected);
  check("a deposit not deep enough yet is not served (retryable)", !early.isValid && early.reason === "unconfirmed" && early.retryable === true, early.reason);
  await mine(1);
  const verified = await split.verify(paid.proof, expected);
  check("two blocks deep, it is accepted", verified.isValid && verified.splitClaim !== undefined, verified.error);

  const otherPrice = await split.verify({ ...paid.proof, price: "1" }, { ...expected, price: 1n });
  check("the same deposit at another price is refused", !otherPrice.isValid, otherPrice.reason);

  // A throwaway merchant, listed only now: the deposit (hand-built for it, as anyone could) predates its listing.
  const admin = await wallet.createSchnorrAccount(LOCAL_ADMIN_SECRET, Fr.ZERO, signingKeyFor(LOCAL_ADMIN_SECRET));
  const late = await AztecAddress.random();
  const pretend: MerchantList = await syncMerchantList(node, split.token).then((l) => {
    const entries = new Map(l.entries);
    const any = [...l.entries.values()][0];
    if (any) entries.set(late.toString(), any);
    return { ...l, entries };
  });
  const lateTerms = { ...t, merchant: late.toString() };
  const early2 = await paySplit({ l1: otherKey, m, node, terms: lateTerms, buyer: buyer.address, list: pretend });
  await addMerchants({ wallet, m, node }, admin.address, [late]);
  await mine(2);
  const lateMerchant = await SplitMerchant.create({
    manifest: m,
    l1: boundKey.publicClient,
    node,
    wallet,
    merchant: late,
  });
  const beforeListing = await lateMerchant.verify(early2.proof, expected);
  check("a deposit made before the merchant's listing landed is refused for good", !beforeListing.isValid && beforeListing.reason === "before-listing" && !beforeListing.retryable, beforeListing.reason);
  const otherMerchant = await split.verify(early2.proof, expected);
  check("a deposit for another merchant is refused", !otherMerchant.isValid && otherMerchant.reason === "not-found", otherMerchant.reason);

  const status = await claimed(t.paymentRef, verified.splitClaim ?? "");
  check("the claim job claims the deposit on Aztec", status === "claimed", status);
  const merchantGot = (await l2UsdcBalance(wallet, m, seller.address, "private")) - merchantBefore;
  check("the merchant received exactly the price", merchantGot === PRICE, `${merchantGot}`);

  const change = changeOf(paid.ticket);
  check("the change is owed to the buyer", change !== undefined && (await changeState(change, node, m)) === "owed");
  if (change) {
    await claimChange(change, node, wallet, m, { allowBind: true });
    const buyerGot = (await l2UsdcBalance(wallet, m, buyer.address, "private")) - buyerBefore;
    check("the buyer collected the change", buyerGot === 1_000_000n - PRICE, `${buyerGot}`);
    check("and it is settled", (await changeState(change, node, m)) === "settled");
  }

  // A second deposit from an L1 key the buyer is not bound to: the merchant is paid, the change cannot be collected.
  const t2 = await terms();
  const fromOther = await paySplit({ l1: otherKey, m, node, terms: t2, buyer: buyer.address });
  await mine(2);
  const v2 = await split.verify(fromOther.proof, { paymentRef: t2.paymentRef, price: PRICE });
  check("a deposit from another L1 key pays the merchant all the same", v2.isValid, v2.error);
  check("and is claimed", (await claimed(t2.paymentRef, v2.splitClaim ?? "")) === "claimed");
  const change2 = changeOf(fromOther.ticket);
  let bound = "no error";
  if (change2) {
    try {
      await claimChange(change2, node, wallet, m, { allowBind: true });
    } catch (error) {
      bound = error instanceof NotFundingAddressError ? "NotFundingAddressError" : String(error);
    }
  }
  check("its change is refused to a buyer bound to another L1 address", bound === "NotFundingAddressError", bound);
} finally {
  await stopHeartbeat();
  await merchant.jobs.stop();
  merchant.store.close?.();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
