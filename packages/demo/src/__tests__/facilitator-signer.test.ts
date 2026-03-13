/**
 * Unit tests for RealFacilitatorAztecSigner.
 *
 * These tests verify the actual verification logic used in the demo server.
 * They use mock node/wallet objects to test without a running Aztec sandbox.
 *
 * Key finding: the current implementation only checks tx status and does NOT
 * verify recipient address, token contract, or payment amount. This means
 * any successful transaction is accepted as valid payment, regardless of
 * who received the funds. See the "verification gap" test group below.
 *
 * NOTE: We avoid importing AztecAddress directly because @aztec/foundation
 * validates field elements at module load time and our synthetic test addresses
 * ("0xbb..bb") exceed the BN254 field modulus. Instead, we use duck-typed mocks
 * that match the AztecAddress interface (toString() → hex string).
 */
import { describe, it, expect, jest } from "bun:test";
import { RealFacilitatorAztecSigner } from "../aztec/facilitator-signer.js";

/** Valid Aztec address (within BN254 field modulus) */
const SERVER_ADDRESS_STR =
  "0x09ee8a90f9c3d7db87b55fb92a3bbfc69e65be5b8d4d135c756ecbfec37a1c01";
const SENDER_ADDRESS_STR =
  "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const TOKEN_ADDRESS_STR =
  "0x0abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const WRONG_ADDRESS_STR =
  "0x0fedcba0987654321fedcba0987654321fedcba0987654321fedcba098765432";
const TX_HASH =
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const REQUIRED_AMOUNT = 100_000n;

/**
 * Duck-typed mock for AztecAddress.
 * RealFacilitatorAztecSigner only calls address.toString()
 * in getAddresses(), so this is sufficient.
 */
function mockAztecAddress(addrStr: string) {
  return {
    toString() {
      return addrStr;
    },
  };
}

interface MockNodeOptions {
  status?: string;
  txEffect?: { noteHashes?: unknown[]; nullifiers?: unknown[] } | null;
  txEffectError?: boolean;
}

function createMockNode(opts?: string | MockNodeOptions) {
  const options: MockNodeOptions =
    typeof opts === "string" ? { status: opts } : opts ?? {};

  return {
    getTxReceipt: jest.fn().mockResolvedValue({
      status: options.status ?? "success",
    }),
    getTxEffect: options.txEffectError
      ? jest.fn().mockRejectedValue(new Error("getTxEffect not supported"))
      : jest.fn().mockResolvedValue(options.txEffect ?? null),
  };
}

function createMockWallet() {
  return {
    registerSender: jest.fn().mockResolvedValue(undefined),
  };
}

function createMockAccount(addr = SERVER_ADDRESS_STR) {
  // Use duck-typed mock instead of real AztecAddress to avoid
  // BN254 field modulus validation at module load time.
  return { address: mockAztecAddress(addr) };
}

function createSigner(opts?: string | MockNodeOptions) {
  return new RealFacilitatorAztecSigner(
    createMockAccount(),
    createMockWallet(),
    createMockNode(opts),
  );
}

describe("RealFacilitatorAztecSigner", () => {
  describe("getAddresses", () => {
    it("returns the account address", async () => {
      const addresses = await createSigner().getAddresses();
      expect(addresses).toEqual([SERVER_ADDRESS_STR]);
    });
  });

  describe("registerSender", () => {
    it("calls wallet.registerSender with the parsed address", async () => {
      const wallet = createMockWallet();
      const signer = new RealFacilitatorAztecSigner(
        createMockAccount(),
        wallet,
        createMockNode(),
      );

      await signer.registerSender(SENDER_ADDRESS_STR);

      // Verify registerSender was called (address is parsed internally)
      expect(wallet.registerSender).toHaveBeenCalledTimes(1);
    });
  });

  describe("verifyPaymentNotes — tx status checks", () => {
    it("accepts a successful transaction", async () => {
      const result = await createSigner("success").verifyPaymentNotes(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        SERVER_ADDRESS_STR,
        REQUIRED_AMOUNT,
      );

      expect(result.isValid).toBe(true);
    });

    it("accepts tx with status 'proposed'", async () => {
      const result = await createSigner("proposed").verifyPaymentNotes(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        SERVER_ADDRESS_STR,
        REQUIRED_AMOUNT,
      );
      expect(result.isValid).toBe(true);
    });

    it("accepts tx with status 'checkpointed'", async () => {
      const result = await createSigner("checkpointed").verifyPaymentNotes(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        SERVER_ADDRESS_STR,
        REQUIRED_AMOUNT,
      );
      expect(result.isValid).toBe(true);
    });

    it("accepts tx with status 'proven'", async () => {
      const result = await createSigner("proven").verifyPaymentNotes(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        SERVER_ADDRESS_STR,
        REQUIRED_AMOUNT,
      );
      expect(result.isValid).toBe(true);
    });

    it("accepts tx with status 'finalized'", async () => {
      const result = await createSigner("finalized").verifyPaymentNotes(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        SERVER_ADDRESS_STR,
        REQUIRED_AMOUNT,
      );
      expect(result.isValid).toBe(true);
    });

    it("rejects a dropped transaction", async () => {
      const result = await createSigner("dropped").verifyPaymentNotes(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        SERVER_ADDRESS_STR,
        REQUIRED_AMOUNT,
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("dropped");
    });

    it("rejects a reverted transaction", async () => {
      const result = await createSigner("reverted").verifyPaymentNotes(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        SERVER_ADDRESS_STR,
        REQUIRED_AMOUNT,
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("reverted");
    });

    it("handles node errors gracefully", async () => {
      const node = {
        getTxReceipt: jest.fn().mockRejectedValue(new Error("node unavailable")),
        getTxEffect: jest.fn().mockResolvedValue(null),
      };
      const signer = new RealFacilitatorAztecSigner(
        createMockAccount(),
        createMockWallet(),
        node,
      );

      const result = await signer.verifyPaymentNotes(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        SERVER_ADDRESS_STR,
        REQUIRED_AMOUNT,
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("node unavailable");
    });
  });

  /**
   * VERIFICATION GAP TESTS
   *
   * These tests document the current limitation: verifyPaymentNotes does NOT
   * validate the recipient address, token contract, or actual payment amount.
   * Any successful transaction is accepted as valid payment.
   *
   * The proper fix is to switch to transfer_private_to_commitment, which
   * allows the facilitator to verify payments via PXE note discovery on
   * commitment-linked notes. See the FIXME in facilitator-signer.ts.
   */
  describe("verification gap — documents current limitation", () => {
    it("KNOWN GAP: accepts payment sent to wrong address", async () => {
      // Payment was sent to WRONG_ADDRESS instead of SERVER_ADDRESS,
      // but verifyPaymentNotes doesn't check the recipient.
      const result = await createSigner("success").verifyPaymentNotes(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        WRONG_ADDRESS_STR, // wrong recipient!
        REQUIRED_AMOUNT,
      );

      // BUG: this should be false, but the current implementation
      // ignores the recipient address and returns true.
      // This test documents the gap — it will need updating when
      // transfer_private_to_commitment is implemented.
      expect(result.isValid).toBe(true);
      expect(result.amountFound).toBe(REQUIRED_AMOUNT);
    });

    it("KNOWN GAP: accepts payment with wrong token", async () => {
      // Payment used a completely different token contract,
      // but verifyPaymentNotes doesn't check the token.
      const result = await createSigner("success").verifyPaymentNotes(
        TX_HASH,
        "0x0999999999999999999999999999999999999999999999999999999999999999", // wrong token!
        SERVER_ADDRESS_STR,
        REQUIRED_AMOUNT,
      );

      // BUG: this should be false, but the current implementation
      // ignores the token address and returns true.
      expect(result.isValid).toBe(true);
    });

    it("KNOWN GAP: reports required amount without verifying actual amount", async () => {
      // We ask for 100_000 but the tx might have transferred only 1.
      // verifyPaymentNotes echoes back the required amount without
      // checking the actual amount in the transaction notes.
      const result = await createSigner("success").verifyPaymentNotes(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        SERVER_ADDRESS_STR,
        100_000n,
      );

      // BUG: amountFound should reflect the actual amount from the tx,
      // not just echo back the required amount.
      expect(result.amountFound).toBe(100_000n);
    });
  });

  describe("verifyPaymentNotes — tx effect validation", () => {
    it("rejects transaction with no note hashes (not a private transfer)", async () => {
      const result = await createSigner({
        status: "success",
        txEffect: { noteHashes: [], nullifiers: [] },
      }).verifyPaymentNotes(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        SERVER_ADDRESS_STR,
        REQUIRED_AMOUNT,
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("no private notes");
    });

    it("rejects transaction where all note hashes are zero", async () => {
      const result = await createSigner({
        status: "success",
        txEffect: { noteHashes: ["0", "0x0", "0"], nullifiers: [] },
      }).verifyPaymentNotes(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        SERVER_ADDRESS_STR,
        REQUIRED_AMOUNT,
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("no private notes");
    });

    it("accepts transaction with non-zero note hashes", async () => {
      const result = await createSigner({
        status: "success",
        txEffect: {
          noteHashes: [
            "0x0abababababababababababababababababababababababababababababababab",
            "0x0cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
          ],
          nullifiers: [
            "0x0efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef",
          ],
        },
      }).verifyPaymentNotes(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        SERVER_ADDRESS_STR,
        REQUIRED_AMOUNT,
      );

      expect(result.isValid).toBe(true);
    });

    it("still accepts when getTxEffect is not available (graceful fallback)", async () => {
      const result = await createSigner({
        status: "success",
        txEffectError: true,
      }).verifyPaymentNotes(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        SERVER_ADDRESS_STR,
        REQUIRED_AMOUNT,
      );

      // Falls back to trust-based check when getTxEffect isn't available
      expect(result.isValid).toBe(true);
    });

    it("still accepts when getTxEffect returns null (tx effect not found)", async () => {
      const result = await createSigner({
        status: "success",
        txEffect: null,
      }).verifyPaymentNotes(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        SERVER_ADDRESS_STR,
        REQUIRED_AMOUNT,
      );

      // Falls back to trust-based check when tx effect isn't available
      expect(result.isValid).toBe(true);
    });
  });
});
