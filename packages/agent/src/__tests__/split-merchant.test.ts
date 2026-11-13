import { describe, expect, mock, test } from "bun:test";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import * as events from "@aztec-labs/aztec.js/events";
import { Fr } from "@aztec-labs/aztec.js/fields";
import * as sdk from "@galactica-net/inference-money-core";
import { TESTNET_MANIFEST } from "@galactica-net/inference-money-core/deployments";

const MERCHANT = AztecAddress.fromStringUnsafe("0x09ee8a90f9c3d7db87b55fb92a3bbfc69e65be5b8d4d135c756ecbfec37a1c01");
const OTHER = AztecAddress.fromStringUnsafe("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
const H = (b: string): `0x${string}` => `0x${b.repeat(32)}`;
const REF = H("0f");
const manifest = sdk.parseManifest(TESTNET_MANIFEST);
const LISTED_AT = 1_000n;

const proof = { l1TxHash: H("ee"), price: "10000", paymentRef: REF, changeCommitment: H("01"), salt: H("02") };
const claim: sdk.SplitClaim = {
  amount: 1_000_000n,
  depositor: `0x${"12".repeat(20)}`,
  leafIndex: 3n,
  messageHash: H("34"),
  merchant: MERCHANT,
  price: 10_000n,
  paymentRef: Fr.fromHexString(REF),
  changeCommitment: new Fr(1n),
  salt: new Fr(2n),
};

const entry = (over: Partial<sdk.MerchantEntry> = {}): sdk.MerchantEntry => ({
  off: false,
  scheduledOff: false,
  changeAt: 0n,
  delay: undefined,
  scheduledDelay: undefined,
  delayChangeAt: 0n,
  ...over,
});

interface Setup {
  listed?: boolean;
  entry?: sdk.MerchantEntry;
  verify?: () => Promise<sdk.SplitClaim>;
  depositTime?: bigint;
  finalized?: bigint;
}

async function merchant(s: Setup = {}, opts: { finalizedAbove?: bigint } = {}) {
  mock.module("@aztec-labs/aztec.js/events", () => ({
    ...events,
    getPublicEvents: async () => ({
      events: (s.listed ?? true) ? [{ event: { account: OTHER } }, { event: { account: MERCHANT }, metadata: { l2BlockNumber: 42 } }] : [],
    }),
  }));
  const list: sdk.MerchantList = { block: 50, at: 2_000n, entries: new Map([[MERCHANT.toString(), s.entry ?? entry()]]) };
  mock.module("@galactica-net/inference-money-core", () => ({
    ...sdk,
    syncMerchantList: async () => list,
    verifySplitDeposit: s.verify ?? (async () => claim),
  }));
  const { SplitMerchant } = await import("../aztec/split-merchant.js");
  const node = Object.assign(Object.create(null), {
    getBlockData: async () => ({ header: { globalVariables: { timestamp: LISTED_AT } } }),
  });
  const l1 = Object.assign(Object.create(null), {
    getTransactionReceipt: async () => ({ blockNumber: 100n }),
    getBlockNumber: async () => 101n,
    getBlock: async (args: { blockNumber?: bigint; blockTag?: string }) =>
      args.blockTag === "finalized" ? { number: s.finalized ?? 0n, timestamp: 0n } : { number: 100n, timestamp: s.depositTime ?? 5_000n },
  });
  return SplitMerchant.create({ manifest, l1, node, wallet: Object.create(null), merchant: MERCHANT, ...opts });
}

const expected = { paymentRef: REF, price: 10_000n };

describe("SplitMerchant", () => {
  test("reads the listing's block time and offers the denominations of at least the price", async () => {
    const m = await merchant();
    expect(m.listingTime).toBe(LISTED_AT);
    const terms = await m.terms(10_000n);
    expect(terms).toMatchObject({ merchant: MERCHANT.toString(), price: "10000", chainId: manifest.l1.chainId, portal: manifest.l1.portal });
    expect(terms?.denominations[0]).toBe("1000000");
    expect((await m.terms(7_000_000n))?.denominations[0]).toBe("10000000");
  });

  test("offers nothing while not listed, or once a switch-off is scheduled", async () => {
    expect(await (await merchant({ listed: false })).terms(10_000n)).toBeUndefined();
    const switchingOff = entry({ scheduledOff: true, changeAt: 3_000n });
    expect(await (await merchant({ entry: switchingOff })).terms(10_000n)).toBeUndefined();
  });

  test("accepts a confirmed deposit made after the listing and returns the claim to persist", async () => {
    const result = await (await merchant()).verify(proof, expected);
    expect(result).toMatchObject({ isValid: true, transaction: proof.l1TxHash, amountFound: 10_000n });
    const { parseSplitClaim } = await import("../aztec/split-merchant.js");
    expect(parseSplitClaim(result.splitClaim ?? "").claim.leafIndex).toBe(3n);
  });

  test("refuses for good a deposit made before the listing landed", async () => {
    const result = await (await merchant({ depositTime: LISTED_AT })).verify(proof, expected);
    expect(result).toMatchObject({ isValid: false, reason: "before-listing" });
    expect(result.retryable).toBeUndefined();
  });

  test("refuses for good a deposit while the merchant is switched off or will be before it can claim", async () => {
    // The list is read at 2_000; the claim needs the merchant until 2_000 + CLAIM_MARGIN_SECONDS.
    const { CLAIM_MARGIN_SECONDS } = await import("../aztec/split-merchant.js");
    const soon = entry({ scheduledOff: true, changeAt: 2_000n + CLAIM_MARGIN_SECONDS });
    const result = await (await merchant({ entry: soon })).verify(proof, expected);
    expect(result).toMatchObject({ isValid: false, reason: "switching-off" });
    expect(result.retryable).toBeUndefined();
    const off = await (await merchant({ entry: entry({ off: true, scheduledOff: true }) })).verify(proof, expected);
    expect(off).toMatchObject({ isValid: false, reason: "switching-off" });
  });

  test("still serves while a scheduled switch-off leaves time to claim, and rebuilds a served claim during a switch-off", async () => {
    // Too late for new quotes (terms() wants the longest delay), not for a deposit paid on an earlier one.
    const later = entry({ scheduledOff: true, changeAt: 2_000n + 2n * 3_600n });
    const m = await merchant({ entry: later });
    expect(await m.terms(10_000n)).toBeUndefined();
    expect((await m.verify(proof, expected)).isValid).toBe(true);

    const { serializeSplitClaim } = await import("../aztec/split-merchant.js");
    const off = await merchant({ entry: entry({ off: true, scheduledOff: true }) });
    expect(await off.rebuild(serializeSplitClaim(claim, proof))).toBeDefined();
  });

  test("keeps the claim unchanged on a rebuild while the deposit cannot be confirmed yet, and drops it only when refused for good", async () => {
    const { serializeSplitClaim } = await import("../aztec/split-merchant.js");
    const stored = serializeSplitClaim(claim, proof);
    const lagging = await merchant({ verify: async () => Promise.reject(new sdk.SplitProofRefusedError("unconfirmed", "1 confirmation")) });
    expect(await lagging.rebuild(stored)).toBe(stored);
    const notFinal = await merchant({ finalized: 99n }, { finalizedAbove: 10_000n });
    expect(await notFinal.rebuild(stored)).toBe(stored);
    const underpaid = await merchant({ verify: async () => Promise.reject(new sdk.SplitProofRefusedError("underpaid", "less")) });
    expect(await underpaid.rebuild(stored)).toBeUndefined();
  });

  test("maps the SDK's refusals: unconfirmed is retryable, underpaid is not", async () => {
    const unconfirmed = await merchant({ verify: async () => Promise.reject(new sdk.SplitProofRefusedError("unconfirmed", "1 confirmation")) });
    expect(await unconfirmed.verify(proof, expected)).toMatchObject({ isValid: false, reason: "unconfirmed", retryable: true });
    const underpaid = await merchant({ verify: async () => Promise.reject(new sdk.SplitProofRefusedError("underpaid", "less")) });
    expect(await underpaid.verify(proof, expected)).toMatchObject({ isValid: false, reason: "underpaid", retryable: false });
  });

  test("waits for L1 finality at and above the configured price", async () => {
    const notFinal = await merchant({ finalized: 99n }, { finalizedAbove: 10_000n });
    expect(await notFinal.verify(proof, expected)).toMatchObject({ isValid: false, reason: "unconfirmed", retryable: true });
    const final = await merchant({ finalized: 100n }, { finalizedAbove: 10_000n });
    expect((await final.verify(proof, expected)).isValid).toBe(true);
    const cheap = await merchant({ finalized: 0n }, { finalizedAbove: 20_000n });
    expect((await cheap.verify(proof, expected)).isValid).toBe(true);
  });
});
