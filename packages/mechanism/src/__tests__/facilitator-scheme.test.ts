import { describe, it, expect, jest, beforeEach } from "bun:test";
import { ExactAztecFacilitatorScheme } from "../exact/facilitator/scheme.js";
import type { FacilitatorAztecSigner, AztecNetwork } from "@aztech-x402/core";
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
    registerSender: jest.fn().mockResolvedValue(undefined),
    getPrivateBalance: jest.fn().mockResolvedValue(0n),
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
      // getSigners is sync, returns cached addresses
      expect(Array.isArray(signers)).toBe(true);
    });
  });

  describe("getExtra", () => {
    it("returns undefined (no extra data needed for Aztec)", () => {
      expect(scheme.getExtra("aztec:sandbox")).toBeUndefined();
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

    it("registers sender and checks balance delta", async () => {
      // Simulate: balance goes from 0 to 100000 after discovering note
      let callCount = 0;
      signer.getPrivateBalance = jest.fn().mockImplementation(async () => {
        callCount++;
        return callCount === 1 ? 0n : 100_000n;
      });

      const result = await scheme.verify(createPayload(), createRequirements());

      expect(signer.registerSender).toHaveBeenCalledWith(SENDER_ADDRESS);
      expect(result.isValid).toBe(true);
      expect(result.payer).toBe(SENDER_ADDRESS);
    });

    it("rejects when balance delta is insufficient", async () => {
      // Balance doesn't change enough
      let callCount = 0;
      signer.getPrivateBalance = jest.fn().mockImplementation(async () => {
        callCount++;
        return callCount === 1 ? 0n : 50_000n; // only half the required amount
      });

      const result = await scheme.verify(createPayload(), createRequirements());

      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toContain("insufficient");
    });

    it("accepts when balance delta exactly matches", async () => {
      let callCount = 0;
      signer.getPrivateBalance = jest.fn().mockImplementation(async () => {
        callCount++;
        return callCount === 1 ? 500_000n : 600_000n; // delta = 100000
      });

      const result = await scheme.verify(createPayload(), createRequirements());

      expect(result.isValid).toBe(true);
    });

    it("accepts when balance delta exceeds requirement (overpayment)", async () => {
      let callCount = 0;
      signer.getPrivateBalance = jest.fn().mockImplementation(async () => {
        callCount++;
        return callCount === 1 ? 0n : 200_000n; // double the amount
      });

      const result = await scheme.verify(createPayload(), createRequirements());

      expect(result.isValid).toBe(true);
    });
  });

  describe("settle", () => {
    it("returns success with the tx hash from the payload", async () => {
      // For Aztec private transfers, settlement happens at transfer time
      // (client already submitted the tx), so settle just acknowledges
      const result = await scheme.settle(createPayload(), createRequirements());

      expect(result.success).toBe(true);
      expect(result.transaction).toBe(TX_HASH);
      expect(result.network).toBe("aztec:sandbox");
      expect(result.payer).toBe(SENDER_ADDRESS);
    });
  });
});
