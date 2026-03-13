/**
 * Unit tests for RealFacilitatorAztecSigner.
 *
 * These tests verify the commitment-based payment verification used in the
 * demo server. They use mock node/token objects to test without a running
 * Aztec sandbox.
 *
 * Key improvements over the old transfer_private_to_private approach:
 * - Recipient verification is guaranteed by the commitment pattern
 *   (facilitator creates partial note for its own address)
 * - Remaining gap: amount verification requires PXE note queries
 *
 * NOTE: We avoid importing AztecAddress directly because @aztec/foundation
 * validates field elements at module load time and our synthetic test addresses
 * exceed the BN254 field modulus. Instead, we use duck-typed mocks.
 */
import { describe, it, expect, jest } from "bun:test";
import { RealFacilitatorAztecSigner } from "../aztec/facilitator-signer.js";

/** Valid Aztec address (within BN254 field modulus) */
const SERVER_ADDRESS_STR =
  "0x09ee8a90f9c3d7db87b55fb92a3bbfc69e65be5b8d4d135c756ecbfec37a1c01";
const TOKEN_ADDRESS_STR =
  "0x0abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const TX_HASH =
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const MOCK_COMMITMENT =
  "0x0aaabbbcccdddeee0aaabbbcccdddeee0aaabbbcccdddeee0aaabbbcccdddeee";
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
  txEffect?: {
    noteHashes?: unknown[];
    nullifiers?: unknown[];
    data?: { noteHashes?: unknown[]; nullifiers?: unknown[] };
  } | null;
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

function createMockToken(commitmentResult: unknown = { commitment: MOCK_COMMITMENT }) {
  const mockInteraction = {
    simulate: jest.fn().mockResolvedValue(commitmentResult),
    send: jest.fn().mockResolvedValue({ txHash: { toString: () => TX_HASH } }),
  };
  return {
    methods: {
      prepare_private_balance_increase: jest.fn().mockReturnValue(mockInteraction),
    },
  };
}

function createMockAccount(addr = SERVER_ADDRESS_STR) {
  return { address: mockAztecAddress(addr) };
}

function createSigner(opts?: string | MockNodeOptions) {
  return new RealFacilitatorAztecSigner(
    createMockAccount(),
    createMockNode(opts),
    createMockToken(),
  );
}

describe("RealFacilitatorAztecSigner", () => {
  describe("getAddresses", () => {
    it("returns the account address", async () => {
      const addresses = await createSigner().getAddresses();
      expect(addresses).toEqual([SERVER_ADDRESS_STR]);
    });
  });

  describe("prepareCommitment", () => {
    it("calls prepare_private_balance_increase on the token contract", async () => {
      const token = createMockToken();
      const account = createMockAccount();
      const signer = new RealFacilitatorAztecSigner(
        account,
        createMockNode(),
        token,
      );

      await signer.prepareCommitment(TOKEN_ADDRESS_STR);

      expect(token.methods.prepare_private_balance_increase).toHaveBeenCalledWith(
        account.address,
      );
    });

    it("simulates and sends the partial note transaction", async () => {
      const token = createMockToken();
      const account = createMockAccount();
      const signer = new RealFacilitatorAztecSigner(
        account,
        createMockNode(),
        token,
      );

      await signer.prepareCommitment(TOKEN_ADDRESS_STR);

      const interaction = token.methods.prepare_private_balance_increase.mock.results[0].value;
      expect(interaction.simulate).toHaveBeenCalledWith({ from: account.address });
      expect(interaction.send).toHaveBeenCalled();
    });

    it("returns the commitment from simulate result (object shape)", async () => {
      const token = createMockToken({ commitment: MOCK_COMMITMENT });
      const signer = new RealFacilitatorAztecSigner(
        createMockAccount(),
        createMockNode(),
        token,
      );

      const result = await signer.prepareCommitment(TOKEN_ADDRESS_STR);
      expect(result).toBe(MOCK_COMMITMENT);
    });

    it("returns the commitment from simulate result (raw value shape)", async () => {
      const token = createMockToken(MOCK_COMMITMENT);
      const signer = new RealFacilitatorAztecSigner(
        createMockAccount(),
        createMockNode(),
        token,
      );

      const result = await signer.prepareCommitment(TOKEN_ADDRESS_STR);
      expect(result).toBe(MOCK_COMMITMENT);
    });

    it("passes fee options when configured", async () => {
      const token = createMockToken();
      const mockFee = { paymentMethod: "sponsored" };
      const signer = new RealFacilitatorAztecSigner(
        createMockAccount(),
        createMockNode(),
        token,
        { fee: mockFee },
      );

      await signer.prepareCommitment(TOKEN_ADDRESS_STR);

      const interaction = token.methods.prepare_private_balance_increase.mock.results[0].value;
      const sendCall = interaction.send.mock.calls[0][0];
      expect(sendCall.fee).toBe(mockFee);
    });
  });

  describe("verifyPayment — tx status checks", () => {
    it("accepts a successful transaction", async () => {
      const result = await createSigner("success").verifyPayment(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        REQUIRED_AMOUNT,
      );
      expect(result.isValid).toBe(true);
    });

    it("accepts tx with status 'proposed'", async () => {
      const result = await createSigner("proposed").verifyPayment(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        REQUIRED_AMOUNT,
      );
      expect(result.isValid).toBe(true);
    });

    it("accepts tx with status 'checkpointed'", async () => {
      const result = await createSigner("checkpointed").verifyPayment(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        REQUIRED_AMOUNT,
      );
      expect(result.isValid).toBe(true);
    });

    it("accepts tx with status 'proven'", async () => {
      const result = await createSigner("proven").verifyPayment(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        REQUIRED_AMOUNT,
      );
      expect(result.isValid).toBe(true);
    });

    it("accepts tx with status 'finalized'", async () => {
      const result = await createSigner("finalized").verifyPayment(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        REQUIRED_AMOUNT,
      );
      expect(result.isValid).toBe(true);
    });

    it("rejects a dropped transaction", async () => {
      const result = await createSigner("dropped").verifyPayment(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        REQUIRED_AMOUNT,
      );
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("dropped");
    });

    it("rejects a reverted transaction", async () => {
      const result = await createSigner("reverted").verifyPayment(
        TX_HASH,
        TOKEN_ADDRESS_STR,
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
        node,
        createMockToken(),
      );

      const result = await signer.verifyPayment(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        REQUIRED_AMOUNT,
      );
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("node unavailable");
    });
  });

  describe("verifyPayment — tx effect validation", () => {
    it("rejects transaction with no note hashes", async () => {
      const result = await createSigner({
        status: "success",
        txEffect: { noteHashes: [], nullifiers: [] },
      }).verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, REQUIRED_AMOUNT);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("no private notes");
    });

    it("rejects transaction where all note hashes are zero (short form)", async () => {
      const result = await createSigner({
        status: "success",
        txEffect: { noteHashes: ["0", "0x0", "0"], nullifiers: [] },
      }).verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, REQUIRED_AMOUNT);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("no private notes");
    });

    it("rejects transaction where all note hashes are Fr.ZERO (full 66-char hex)", async () => {
      const FR_ZERO = "0x" + "0".repeat(64);
      const result = await createSigner({
        status: "success",
        txEffect: { noteHashes: [FR_ZERO, FR_ZERO], nullifiers: [] },
      }).verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, REQUIRED_AMOUNT);

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
      }).verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, REQUIRED_AMOUNT);

      expect(result.isValid).toBe(true);
    });

    it("handles wrapped SDK shape (IndexedTxEffect with data property)", async () => {
      const result = await createSigner({
        status: "success",
        txEffect: {
          data: {
            noteHashes: [
              "0x0abababababababababababababababababababababababababababababababab",
            ],
            nullifiers: [],
          },
        },
      }).verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, REQUIRED_AMOUNT);

      expect(result.isValid).toBe(true);
    });

    it("rejects wrapped SDK shape with no notes", async () => {
      const result = await createSigner({
        status: "success",
        txEffect: {
          data: { noteHashes: [], nullifiers: [] },
        },
      }).verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, REQUIRED_AMOUNT);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain("no private notes");
    });

    it("still accepts when getTxEffect is not available (graceful fallback)", async () => {
      const result = await createSigner({
        status: "success",
        txEffectError: true,
      }).verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, REQUIRED_AMOUNT);

      expect(result.isValid).toBe(true);
    });

    it("still accepts when getTxEffect returns null", async () => {
      const result = await createSigner({
        status: "success",
        txEffect: null,
      }).verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, REQUIRED_AMOUNT);

      expect(result.isValid).toBe(true);
    });
  });

  /**
   * COMMITMENT PATTERN — RECIPIENT VERIFICATION IS NOW CLOSED
   *
   * With the commitment pattern, the facilitator creates the partial note
   * for its own address. This means recipient verification is inherent:
   * the note can ONLY go to the facilitator's address.
   *
   * Remaining gap: amount verification requires PXE note queries.
   */
  describe("remaining verification gap — amount", () => {
    it("KNOWN GAP: reports required amount without verifying actual amount", async () => {
      // The client chooses the amount when calling
      // finalize_transfer_to_private_from_private. A full implementation
      // would query the PXE for the specific note value.
      const result = await createSigner("success").verifyPayment(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        100_000n,
      );

      // amountFound echoes the required amount — a future improvement would
      // check the actual note value via PXE queries.
      expect(result.amountFound).toBe(100_000n);
    });
  });
});
