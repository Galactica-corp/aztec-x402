import { describe, it, expect, jest, beforeEach } from "bun:test";
import { ExactAztecFacilitatorScheme } from "../exact/facilitator/scheme.js";
import type { FacilitatorAztecSigner, AztecNetwork } from "@aztec-x402/core";
import type {
  PaymentPayload,
  PaymentRequirements,
} from "../x402-types.js";

const SERVER_ADDRESS = "0x" + "bb".repeat(32);
const SENDER_ADDRESS = "0x" + "aa".repeat(32);
const TOKEN_ADDRESS = "0x" + "dd".repeat(32);
const TX_HASH = "0x" + "cc".repeat(32);

function createMockSigner(
  overrides?: Partial<FacilitatorAztecSigner>,
): FacilitatorAztecSigner {
  return {
    getAddresses: jest.fn().mockResolvedValue([SERVER_ADDRESS]),
    verifyPayment: jest.fn().mockResolvedValue({ isValid: true, amountFound: 100_000n }),
    ...overrides,
  };
}

function createRequirements(
  overrides?: Partial<PaymentRequirements>,
): PaymentRequirements {
  return {
    scheme: "exact",
    network: "aztec:sandbox",
    asset: TOKEN_ADDRESS,
    amount: "100000",
    payTo: SERVER_ADDRESS,
    maxTimeoutSeconds: 120,
    extra: {},
    ...overrides,
  };
}

function createPayload(
  overrides?: Partial<PaymentPayload>,
): PaymentPayload {
  return {
    x402Version: 2,
    accepted: createRequirements(),
    payload: {
      senderAddress: SENDER_ADDRESS,
      correlationId: "test-correlation-id",
      txHash: TX_HASH,
      timestamp: new Date().toISOString(),
    },
    ...overrides,
  };
}

describe("ExactAztecFacilitatorScheme", () => {
  let scheme: ExactAztecFacilitatorScheme;
  let signer: FacilitatorAztecSigner;
  const networks: AztecNetwork[] = ["aztec:sandbox"];

  beforeEach(() => {
    signer = createMockSigner();
    scheme = new ExactAztecFacilitatorScheme(signer, networks);
  });

  describe("metadata", () => {
    it('has scheme "exact"', () => {
      expect(scheme.scheme).toBe("exact");
    });

    it('has caipFamily "aztec:*"', () => {
      expect(scheme.caipFamily).toBe("aztec:*");
    });
  });

  describe("getSigners", () => {
    it("returns facilitator addresses", () => {
      const signers = scheme.getSigners("aztec:sandbox");
      expect(Array.isArray(signers)).toBe(true);
    });
  });

  describe("getExtra", () => {
    it("returns undefined (no commitment needed)", () => {
      expect(scheme.getExtra("aztec:sandbox")).toBeUndefined();
    });
  });

  describe("preparePayment", () => {
    it("returns empty object (no commitment needed for direct transfer)", async () => {
      const extra = await scheme.preparePayment(TOKEN_ADDRESS);
      expect(extra).toEqual({});
    });
  });

  describe("verify", () => {
    it("rejects payload with missing sender address", async () => {
      const payload = createPayload({
        payload: {
          correlationId: "test",
          txHash: TX_HASH,
          timestamp: new Date().toISOString(),
        },
      });

      const result = await scheme.verify(payload, createRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toContain("senderAddress");
    });

    it("rejects payload with missing correlation ID", async () => {
      const payload = createPayload({
        payload: {
          senderAddress: SENDER_ADDRESS,
          txHash: TX_HASH,
          timestamp: new Date().toISOString(),
        },
      });

      const result = await scheme.verify(payload, createRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toContain("correlationId");
    });

    it("rejects payload with missing txHash", async () => {
      const payload = createPayload({
        payload: {
          senderAddress: SENDER_ADDRESS,
          correlationId: "test",
          timestamp: new Date().toISOString(),
        },
      });

      const result = await scheme.verify(payload, createRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toContain("txHash");
    });

    it("rejects payload with invalid sender address format", async () => {
      const payload = createPayload({
        payload: {
          senderAddress: "invalid-address",
          correlationId: "test",
          txHash: TX_HASH,
          timestamp: new Date().toISOString(),
        },
      });

      const result = await scheme.verify(payload, createRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toContain("address");
    });

    it("verifies payment using direct transfer verification", async () => {
      const result = await scheme.verify(createPayload(), createRequirements());

      expect(signer.verifyPayment).toHaveBeenCalledWith(
        TX_HASH,
        TOKEN_ADDRESS,
        100_000n,
      );
      expect(result.isValid).toBe(true);
      expect(result.payer).toBe(SENDER_ADDRESS);
    });

    it("rejects when payment verification fails", async () => {
      signer.verifyPayment = jest.fn().mockResolvedValue({
        isValid: false,
        amountFound: 50_000n,
        error: "insufficient payment: found 50000, need 100000",
      });

      const result = await scheme.verify(createPayload(), createRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toContain("insufficient");
    });

    it("accepts when payment verification succeeds", async () => {
      signer.verifyPayment = jest.fn().mockResolvedValue({
        isValid: true,
        amountFound: 100_000n,
      });

      const result = await scheme.verify(createPayload(), createRequirements());

      expect(result.isValid).toBe(true);
    });

    it("rejects when tx not found", async () => {
      signer.verifyPayment = jest.fn().mockResolvedValue({
        isValid: false,
        amountFound: 0n,
        error: "transaction status is 'dropped'",
      });

      const result = await scheme.verify(createPayload(), createRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toContain("dropped");
    });

    it("rejects payment with no private notes", async () => {
      signer.verifyPayment = jest.fn().mockResolvedValue({
        isValid: false,
        amountFound: 0n,
        error: "transaction produced no private notes — not a valid private transfer",
      });

      const result = await scheme.verify(createPayload(), createRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toContain("no private notes");
    });

    it("handles verification errors from signer", async () => {
      signer.verifyPayment = jest
        .fn()
        .mockRejectedValue(new Error("node connection lost"));

      const result = await scheme.verify(createPayload(), createRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toContain("node connection lost");
    });

    it("rejects replayed payment with same txHash", async () => {
      const payload = createPayload();
      const requirements = createRequirements();

      // First verify + settle succeeds
      const first = await scheme.verify(payload, requirements);
      expect(first.isValid).toBe(true);
      await scheme.settle(payload, requirements);

      // Replay with same txHash is rejected
      const replay = await scheme.verify(payload, requirements);
      expect(replay.isValid).toBe(false);
      expect(replay.invalidReason).toContain("payment already used");
    });
  });

  describe("settle", () => {
    it("returns success with the tx hash from the payload", async () => {
      const result = await scheme.settle(createPayload(), createRequirements());

      expect(result.success).toBe(true);
      expect(result.transaction).toBe(TX_HASH);
      expect(result.network).toBe("aztec:sandbox");
      expect(result.payer).toBe(SENDER_ADDRESS);
    });
  });
});
