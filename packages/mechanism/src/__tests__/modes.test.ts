import { describe, expect, it, jest } from "bun:test";
import type { ClientAztecSigner, FacilitatorAztecSigner } from "@galactica-net/x402-core";
import { ExactAztecClientScheme } from "../exact/client/scheme.js";
import { ExactAztecFacilitatorScheme } from "../exact/facilitator/scheme.js";
import type { PaymentPayload, PaymentRequirements } from "../x402-types.js";

const H = (byte: string) => "0x" + byte.repeat(32);
const MERCHANT = H("bb");
const TOKEN = H("dd");
const REF = H("0f");
const PORTAL = "0x" + "ab".repeat(20);
const TERMS = { merchant: MERCHANT, price: "10000", denominations: ["1000000", "5000000"], chainId: 31337, portal: PORTAL };

const proof = { txHash: H("cc"), paymentRef: REF, messages: [{ recipient: MERCHANT, contractAddress: TOKEN, ciphertext: ["0x1"], anchorBlockTimestamp: "1" }] };
const splitProof = { l1TxHash: H("ee"), price: "10000", paymentRef: REF, changeCommitment: H("1a"), salt: H("2b") };

function signer(over: Partial<FacilitatorAztecSigner> = {}): FacilitatorAztecSigner {
  return {
    getAddresses: jest.fn().mockResolvedValue([MERCHANT]),
    prepareCommitment: jest.fn().mockResolvedValue(H("ff")),
    verifyPayment: jest.fn().mockResolvedValue({ isValid: true, amountFound: 10_000n }),
    paymentModes: jest.fn(async (_asset: string, wanted: string[]) => wanted),
    splitTerms: jest.fn().mockResolvedValue(TERMS),
    receiveRefPayment: jest.fn().mockResolvedValue({ isValid: true, amountFound: 10_000n, transaction: proof.txHash }),
    verifySplitDeposit: jest.fn().mockResolvedValue({ isValid: true, splitClaim: '{"x":1}', transaction: splitProof.l1TxHash }),
    ...over,
  };
}

function requirements(mode: "ref" | "split", over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "aztec:sandbox",
    asset: TOKEN,
    amount: "10000",
    payTo: MERCHANT,
    maxTimeoutSeconds: 120,
    extra: { nonce: "n1", mode, paymentRef: REF, ...(mode === "split" ? TERMS : {}) },
    ...over,
  };
}

const payload = (mode: "ref" | "split", body: Record<string, unknown>): PaymentPayload => ({
  x402Version: 2,
  accepted: requirements(mode),
  payload: { mode, ...body },
});

describe("offerPayment", () => {
  it("offers the modes the signer supports, in the asked order, sharing the server's reference", async () => {
    const s = signer();
    const offer = await new ExactAztecFacilitatorScheme(s, ["aztec:sandbox"]).offerPayment(TOKEN, "10000", ["ref", "split", "commitment"], REF);
    expect(offer.offers.map((o) => o.mode)).toEqual(["ref", "split", "commitment"]);
    expect(offer.offers[0]?.extra).toEqual({ mode: "ref", paymentRef: REF });
    expect(offer.offers[1]?.extra).toMatchObject({ mode: "split", paymentRef: REF, portal: PORTAL, price: "10000" });
  });

  it("leaves out split when the signer has no terms now, and everything but commitment for a plain signer", async () => {
    const noTerms = signer({ splitTerms: jest.fn().mockResolvedValue(undefined) });
    const offer = await new ExactAztecFacilitatorScheme(noTerms, ["aztec:sandbox"]).offerPayment(TOKEN, "10000", ["ref", "split", "commitment"], REF);
    expect(offer.offers.map((o) => o.mode)).toEqual(["ref", "commitment"]);

    const plain = signer({ paymentModes: undefined });
    const legacy = await new ExactAztecFacilitatorScheme(plain, ["aztec:sandbox"]).offerPayment(TOKEN, "10000", ["ref", "split", "commitment"], REF);
    expect(legacy).toEqual({ offers: [{ mode: "commitment", extra: { mode: "commitment" } }] });
  });
});

describe("verify (ref)", () => {
  it("passes the proof and the server's price to the signer", async () => {
    const s = signer();
    const result = await new ExactAztecFacilitatorScheme(s, ["aztec:sandbox"]).verify(payload("ref", proof), requirements("ref"));
    expect(result.isValid).toBe(true);
    expect(s.receiveRefPayment).toHaveBeenCalledWith(TOKEN, proof, { paymentRef: REF, price: 10_000n });
    expect(result.extensions).toMatchObject({ transaction: proof.txHash, amountFound: "10000" });
  });

  it("refuses a proof for another reference without asking the signer", async () => {
    const s = signer();
    const result = await new ExactAztecFacilitatorScheme(s, ["aztec:sandbox"]).verify(
      payload("ref", { ...proof, paymentRef: H("01") }),
      requirements("ref"),
    );
    expect(result).toMatchObject({ isValid: false, invalidReason: "malformed" });
    expect(s.receiveRefPayment).not.toHaveBeenCalled();
  });

  it("refuses a malformed proof", async () => {
    const result = await new ExactAztecFacilitatorScheme(signer(), ["aztec:sandbox"]).verify(
      payload("ref", { ...proof, messages: [] }),
      requirements("ref"),
    );
    expect(result).toMatchObject({ isValid: false, invalidReason: "malformed" });
  });

  it("marks a retryable refusal and an unexpected error as retryable, a final one not", async () => {
    const notMined = signer({ receiveRefPayment: jest.fn().mockResolvedValue({ isValid: false, reason: "not-mined", retryable: true }) });
    const r1 = await new ExactAztecFacilitatorScheme(notMined, ["aztec:sandbox"]).verify(payload("ref", proof), requirements("ref"));
    expect(r1).toMatchObject({ isValid: false, invalidReason: "not-mined", extensions: { retryable: true } });

    const underpaid = signer({ receiveRefPayment: jest.fn().mockResolvedValue({ isValid: false, reason: "underpaid" }) });
    const r2 = await new ExactAztecFacilitatorScheme(underpaid, ["aztec:sandbox"]).verify(payload("ref", proof), requirements("ref"));
    expect(r2.isValid).toBe(false);
    expect(r2.extensions).toBeUndefined();

    const down = signer({ receiveRefPayment: jest.fn().mockRejectedValue(new Error("node down")) });
    const r3 = await new ExactAztecFacilitatorScheme(down, ["aztec:sandbox"]).verify(payload("ref", proof), requirements("ref"));
    expect(r3).toMatchObject({ isValid: false, extensions: { retryable: true } });
  });
});

describe("verify (split)", () => {
  it("returns the claim to persist", async () => {
    const s = signer();
    const result = await new ExactAztecFacilitatorScheme(s, ["aztec:sandbox"]).verify(payload("split", splitProof), requirements("split"));
    expect(result).toMatchObject({ isValid: true, extensions: { splitClaim: '{"x":1}' } });
    expect(s.verifySplitDeposit).toHaveBeenCalledWith(TOKEN, splitProof, { paymentRef: REF, price: 10_000n });
  });

  it("refuses a proof at another price", async () => {
    const s = signer();
    const result = await new ExactAztecFacilitatorScheme(s, ["aztec:sandbox"]).verify(
      payload("split", { ...splitProof, price: "1" }),
      requirements("split"),
    );
    expect(result).toMatchObject({ isValid: false, invalidReason: "malformed" });
    expect(s.verifySplitDeposit).not.toHaveBeenCalled();
  });

  it("settles with the L1 transaction", async () => {
    const settled = await new ExactAztecFacilitatorScheme(signer(), ["aztec:sandbox"]).settle(payload("split", splitProof), requirements("split"));
    expect(settled).toMatchObject({ success: true, transaction: splitProof.l1TxHash });
  });
});

describe("client scheme", () => {
  const commitment: PaymentRequirements = { ...requirements("ref"), extra: { nonce: "n1", mode: "commitment" } };
  const client = (over: Partial<ClientAztecSigner> = {}) =>
    new ExactAztecClientScheme({
      getAddress: async () => H("aa"),
      finalizePayment: async () => H("cc"),
      ...over,
    });

  it("selects ref only when the signer can pay privately, split only with an L1 wallet", () => {
    const accepts = [requirements("ref"), requirements("split"), commitment];
    expect(client().selectRequirement(accepts)).toBe(commitment);
    expect(client({ payPrivate: async () => proof }).selectRequirement(accepts)).toBe(accepts[0]);
    expect(client({ paySplit: async () => splitProof }).selectRequirement(accepts)).toBe(accepts[1]);
  });

  it("pays a ref requirement with payPrivate and returns the proof as payload", async () => {
    const payPrivate = jest.fn().mockResolvedValue(proof);
    const result = await client({ payPrivate }).createPaymentPayload(2, requirements("ref"));
    expect(payPrivate).toHaveBeenCalledWith(TOKEN, MERCHANT, 10_000n, REF);
    expect(result.payload).toEqual({ mode: "ref", ...proof });
  });

  it("refuses split terms that disagree with the requirement", async () => {
    const paySplit = jest.fn().mockResolvedValue(splitProof);
    const bad = requirements("split", { amount: "20000" });
    await expect(client({ paySplit }).createPaymentPayload(2, bad)).rejects.toThrow("disagree");
    expect(paySplit).not.toHaveBeenCalled();
    const ok = await client({ paySplit }).createPaymentPayload(2, requirements("split"));
    expect(ok.payload).toEqual({ mode: "split", ...splitProof });
  });
});
