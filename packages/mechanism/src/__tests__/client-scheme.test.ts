import { describe, it, expect, jest, beforeEach } from "bun:test";
import { ExactAztecClientScheme } from "../exact/client/scheme.js";
import type { ClientAztecSigner } from "@aztec-x402/core";
import type { PaymentRequirements } from "../x402-types.js";

const MOCK_COMMITMENT = "0x" + "ff".repeat(32);

function createMockSigner(overrides?: Partial<ClientAztecSigner>): ClientAztecSigner {
  return {
    getAddress: jest.fn().mockResolvedValue("0x" + "aa".repeat(32)),
    finalizePayment: jest.fn().mockResolvedValue("0x" + "cc".repeat(32)),
    ...overrides,
  };
}

function createPaymentRequirements(
  overrides?: Partial<PaymentRequirements>,
): PaymentRequirements {
  return {
    scheme: "exact",
    network: "aztec:sandbox",
    asset: "0x" + "dd".repeat(32),
    amount: "100000",
    payTo: "0x" + "bb".repeat(32),
    maxTimeoutSeconds: 120,
    extra: { commitment: MOCK_COMMITMENT },
    ...overrides,
  };
}

describe("ExactAztecClientScheme", () => {
  let scheme: ExactAztecClientScheme;
  let signer: ClientAztecSigner;

  beforeEach(() => {
    signer = createMockSigner();
    scheme = new ExactAztecClientScheme(signer);
  });

  it('has scheme "exact"', () => {
    expect(scheme.scheme).toBe("exact");
  });

  it("calls finalizePayment with commitment from requirements", async () => {
    const requirements = createPaymentRequirements();

    await scheme.createPaymentPayload(2, requirements);

    expect(signer.finalizePayment).toHaveBeenCalledWith(
      requirements.asset,
      MOCK_COMMITMENT,
      BigInt(requirements.amount),
    );
  });

  it("returns a payload with sender address and correlation ID", async () => {
    const requirements = createPaymentRequirements();

    const result = await scheme.createPaymentPayload(2, requirements);

    expect(result.x402Version).toBe(2);
    expect(result.payload).toHaveProperty("senderAddress", "0x" + "aa".repeat(32));
    expect(result.payload).toHaveProperty("correlationId");
    expect(result.payload).toHaveProperty("txHash", "0x" + "cc".repeat(32));
    expect(result.payload).toHaveProperty("timestamp");
  });

  it("generates unique correlation IDs", async () => {
    const requirements = createPaymentRequirements();

    const result1 = await scheme.createPaymentPayload(2, requirements);
    const result2 = await scheme.createPaymentPayload(2, requirements);

    expect(result1.payload.correlationId).not.toBe(result2.payload.correlationId);
  });

  it("includes a valid ISO timestamp", async () => {
    const requirements = createPaymentRequirements();

    const result = await scheme.createPaymentPayload(2, requirements);

    const ts = String(result.payload.timestamp);
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  it("throws when commitment is missing from requirements", async () => {
    const requirements = createPaymentRequirements({ extra: {} });

    await expect(
      scheme.createPaymentPayload(2, requirements),
    ).rejects.toThrow("missing commitment");
  });

  it("propagates signer errors", async () => {
    const failingSigner = createMockSigner({
      finalizePayment: jest.fn().mockRejectedValue(new Error("tx failed")),
    });
    const failingScheme = new ExactAztecClientScheme(failingSigner);
    const requirements = createPaymentRequirements();

    await expect(
      failingScheme.createPaymentPayload(2, requirements),
    ).rejects.toThrow("tx failed");
  });
});
