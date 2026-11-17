import { describe, expect, it } from "bun:test";
import {
  MAX_PROOF_MESSAGES,
  RefAztecPayloadSchema,
  SplitAztecPayloadSchema,
  SplitTermsSchema,
  parseAztecPaymentExtra,
  payloadMode,
} from "../index.js";

const H = (byte: string) => "0x" + byte.repeat(32);
const message = (over: Record<string, unknown> = {}) => ({
  recipient: H("bb"),
  contractAddress: H("dd"),
  ciphertext: Array.from({ length: 15 }, (_, i) => "0x" + (i + 1).toString(16)),
  anchorBlockTimestamp: "1762000000",
  ...over,
});
const refPayload = (over: Record<string, unknown> = {}) => ({
  mode: "ref",
  txHash: H("cc"),
  paymentRef: H("0f"),
  messages: [message(), message()],
  ...over,
});
const splitPayload = (over: Record<string, unknown> = {}) => ({
  mode: "split",
  l1TxHash: H("ee"),
  price: "370000",
  paymentRef: H("0f"),
  changeCommitment: H("1a"),
  salt: H("2b"),
  ...over,
});

describe("ref payload", () => {
  it("accepts the SDK's PaymentProof shape", () => {
    expect(RefAztecPayloadSchema.parse(refPayload()).messages).toHaveLength(2);
  });

  it("refuses an empty, oversized or malformed message list", () => {
    expect(RefAztecPayloadSchema.safeParse(refPayload({ messages: [] })).success).toBe(false);
    const many = Array.from({ length: MAX_PROOF_MESSAGES + 1 }, () => message());
    expect(RefAztecPayloadSchema.safeParse(refPayload({ messages: many })).success).toBe(false);
    const longCipher = message({ ciphertext: Array.from({ length: 65 }, () => "0x1") });
    expect(RefAztecPayloadSchema.safeParse(refPayload({ messages: [longCipher] })).success).toBe(false);
    expect(RefAztecPayloadSchema.safeParse(refPayload({ messages: [message({ recipient: "bob" })] })).success).toBe(false);
    expect(RefAztecPayloadSchema.safeParse(refPayload({ messages: [message({ ciphertext: ["12"] })] })).success).toBe(false);
  });

  it("refuses a bad tx hash or reference", () => {
    expect(RefAztecPayloadSchema.safeParse(refPayload({ txHash: "0x12" })).success).toBe(false);
    expect(RefAztecPayloadSchema.safeParse(refPayload({ paymentRef: "abc" })).success).toBe(false);
  });
});

describe("split payload", () => {
  it("accepts the SDK's SplitProof shape", () => {
    expect(SplitAztecPayloadSchema.parse(splitPayload()).price).toBe("370000");
  });

  it("refuses a non-decimal price or a short L1 hash", () => {
    expect(SplitAztecPayloadSchema.safeParse(splitPayload({ price: "-1" })).success).toBe(false);
    expect(SplitAztecPayloadSchema.safeParse(splitPayload({ price: "0x10" })).success).toBe(false);
    expect(SplitAztecPayloadSchema.safeParse(splitPayload({ l1TxHash: "0x" + "e".repeat(40) })).success).toBe(false);
  });
});

describe("split terms", () => {
  it("needs an L1 portal address and at least one denomination", () => {
    const terms = { merchant: H("bb"), price: "10000", denominations: ["1000000"], chainId: 11155111, portal: "0x" + "ab".repeat(20) };
    expect(SplitTermsSchema.parse(terms).chainId).toBe(11155111);
    expect(SplitTermsSchema.safeParse({ ...terms, denominations: [] }).success).toBe(false);
    expect(SplitTermsSchema.safeParse({ ...terms, portal: H("ab") }).success).toBe(false);
  });
});

describe("payloadMode and extra", () => {
  it("reads the mode, or none for the commitment flow", () => {
    expect(payloadMode(refPayload())).toBe("ref");
    expect(payloadMode(splitPayload())).toBe("split");
    expect(payloadMode({ txHash: H("cc") })).toBeUndefined();
    expect(payloadMode({ mode: "bogus" })).toBeUndefined();
  });

  it("parses the mode fields of extra and refuses an unknown mode", () => {
    const extra = parseAztecPaymentExtra({ nonce: "n", mode: "split", paymentRef: H("0f"), chainId: 1, denominations: ["1"] });
    expect(extra.mode).toBe("split");
    expect(() => parseAztecPaymentExtra({ mode: "other" })).toThrow();
  });
});
