/**
 * Unit tests for RealFacilitatorAztecSigner.
 *
 * These tests verify commitment creation and payment verification used in
 * the demo server. They use mock node/token objects to test without a
 * running Aztec sandbox.
 *
 * v4.1.0 API changes (confirmed on sandbox 4.1.0-nightly.20260314):
 * - send() returns { receipt, offchainEffects, offchainMessages }
 * - simulate() returns { result: { commitment }, offchainEffects, offchainMessages }
 * - txHash is on receipt, not top-level
 * - offchainMessages is present but currently empty [] for prepare_private_balance_increase
 *
 * NOTE: We avoid importing AztecAddress directly because @aztec/foundation
 * validates field elements at module load time and our synthetic test addresses
 * exceed the BN254 field modulus. Instead, we use duck-typed mocks.
 */
import { describe, it, expect, jest } from "bun:test";

// Polyfill for @aztec/foundation which calls expect.addEqualityTesters at module load
(expect as unknown as Record<string, unknown>).addEqualityTesters ??= () => {};

const { RealFacilitatorAztecSigner } = await import("../aztec/facilitator-signer.js");

/** Valid Aztec address (within BN254 field modulus) */
const SERVER_ADDRESS_STR =
  "0x09ee8a90f9c3d7db87b55fb92a3bbfc69e65be5b8d4d135c756ecbfec37a1c01";
const CLIENT_ADDRESS_STR =
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TOKEN_ADDRESS_STR =
  "0x0abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const TX_HASH =
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const MOCK_COMMITMENT = "0x" + "ff".repeat(32);
const REQUIRED_AMOUNT = 100_000n;

function mockAztecAddress(addrStr: string) {
  return { toString: () => addrStr };
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

function createMockAccount(addr = SERVER_ADDRESS_STR) {
  return { address: mockAztecAddress(addr) };
}

interface MockTokenOptions {
  /** What simulate() returns */
  simulateResult?: unknown;
  /** What send() returns (v4.1.0 shape) */
  offchainMessages?: Array<{ payload: string; recipient?: string; anchorBlockTimestamp?: number }>;
}

/**
 * Create a mock token contract.
 *
 * Default simulate result uses v4.1.0 shape: { result: { commitment }, offchainEffects: [], offchainMessages: [] }
 * Default send result uses v4.1.0 shape: { receipt: { txHash }, offchainEffects: [], offchainMessages: [] }
 */
function createMockToken(opts?: unknown | MockTokenOptions) {
  // v4.1.0 default simulate result
  let simulateResult: unknown = {
    result: { commitment: MOCK_COMMITMENT },
    offchainEffects: [],
    offchainMessages: [],
  };
  let offchainMessages: Array<{ payload: string; recipient?: string; anchorBlockTimestamp?: number }> | undefined;

  if (opts != null && typeof opts === "object" && ("offchainMessages" in opts || "simulateResult" in opts)) {
    const typedOpts = opts as MockTokenOptions;
    if (typedOpts.simulateResult !== undefined) simulateResult = typedOpts.simulateResult;
    offchainMessages = typedOpts.offchainMessages;
  } else if (opts !== undefined) {
    // Legacy: raw value = simulate result
    simulateResult = opts;
  }

  return {
    methods: {
      prepare_private_balance_increase: jest.fn().mockReturnValue({
        simulate: jest.fn().mockResolvedValue(simulateResult),
        send: jest.fn().mockResolvedValue({
          // v4.1.0 shape: txHash on receipt
          receipt: { txHash: { toString: () => TX_HASH }, status: "success" },
          offchainEffects: [],
          offchainMessages: offchainMessages ?? [],
        }),
      }),
    },
  };
}

function createSigner(opts?: string | MockNodeOptions, tokenOpts?: unknown | MockTokenOptions) {
  return new RealFacilitatorAztecSigner(
    createMockAccount(),
    createMockNode(opts),
    tokenOpts !== undefined ? createMockToken(tokenOpts) : createMockToken(),
  );
}

describe("RealFacilitatorAztecSigner", () => {
  describe("getAddresses", () => {
    it("returns the account address", async () => {
      const addresses = await createSigner().getAddresses();
      expect(addresses).toEqual([SERVER_ADDRESS_STR]);
    });
  });

  describe("verifyPayment — tx status checks", () => {
    it("accepts a successful transaction", async () => {
      const result = await createSigner("success").verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, REQUIRED_AMOUNT);
      expect(result.isValid).toBe(true);
    });

    it("accepts tx with status 'proposed'", async () => {
      const result = await createSigner("proposed").verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, REQUIRED_AMOUNT);
      expect(result.isValid).toBe(true);
    });

    it("accepts tx with status 'checkpointed'", async () => {
      const result = await createSigner("checkpointed").verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, REQUIRED_AMOUNT);
      expect(result.isValid).toBe(true);
    });

    it("accepts tx with status 'proven'", async () => {
      const result = await createSigner("proven").verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, REQUIRED_AMOUNT);
      expect(result.isValid).toBe(true);
    });

    it("accepts tx with status 'finalized'", async () => {
      const result = await createSigner("finalized").verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, REQUIRED_AMOUNT);
      expect(result.isValid).toBe(true);
    });

    it("rejects a dropped transaction", async () => {
      const result = await createSigner("dropped").verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, REQUIRED_AMOUNT);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("dropped");
    });

    it("rejects a reverted transaction", async () => {
      const result = await createSigner("reverted").verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, REQUIRED_AMOUNT);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("reverted");
    });

    it("handles node errors gracefully", async () => {
      const node = {
        getTxReceipt: jest.fn().mockRejectedValue(new Error("node unavailable")),
        getTxEffect: jest.fn().mockResolvedValue(null),
      };
      const signer = new RealFacilitatorAztecSigner(createMockAccount(), node, createMockToken());
      const result = await signer.verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, REQUIRED_AMOUNT);
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

    it("rejects transaction where all note hashes are zero", async () => {
      const result = await createSigner({
        status: "success",
        txEffect: { noteHashes: ["0", "0x0", "0"], nullifiers: [] },
      }).verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, REQUIRED_AMOUNT);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("no private notes");
    });

    it("rejects transaction where all note hashes are Fr.ZERO", async () => {
      const FR_ZERO = "0x" + "0".repeat(64);
      const result = await createSigner({
        status: "success",
        txEffect: { noteHashes: [FR_ZERO, FR_ZERO], nullifiers: [] },
      }).verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, REQUIRED_AMOUNT);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("no private notes");
    });

    it("accepts transaction with non-zero note hashes and nullifiers", async () => {
      const result = await createSigner({
        status: "success",
        txEffect: {
          noteHashes: ["0x0abababababababababababababababababababababababababababababababab"],
          nullifiers: ["0x0efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef"],
        },
      }).verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, REQUIRED_AMOUNT);
      expect(result.isValid).toBe(true);
    });

    it("handles wrapped SDK shape (IndexedTxEffect with data property)", async () => {
      const result = await createSigner({
        status: "success",
        txEffect: {
          data: {
            noteHashes: ["0x0abababababababababababababababababababababababababababababababab"],
            nullifiers: ["0x0efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef"],
          },
        },
      }).verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, REQUIRED_AMOUNT);
      expect(result.isValid).toBe(true);
    });

    it("rejects transaction with notes but no nullifiers", async () => {
      const result = await createSigner({
        status: "success",
        txEffect: {
          noteHashes: ["0x0abababababababababababababababababababababababababababababababab"],
          nullifiers: [],
        },
      }).verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, REQUIRED_AMOUNT);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("no nullifiers");
    });

    it("still accepts when getTxEffect is not available", async () => {
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

  describe("verification analysis", () => {
    it("KNOWN GAP: reports required amount without verifying actual amount", async () => {
      const result = await createSigner("success").verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, 100_000n);
      expect(result.amountFound).toBe(100_000n);
    });

    it("STRUCTURAL: token contract is verified by commitment existence", async () => {
      const result = await createSigner({
        status: "success",
        txEffect: {
          noteHashes: ["0x0abababababababababababababababababababababababababababababababab"],
          nullifiers: ["0x0efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef"],
        },
      }).verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, 100_000n);
      expect(result.isValid).toBe(true);
    });
  });

  describe("prepareCommitment", () => {
    it("calls prepare_private_balance_increase with facilitator and completer addresses", async () => {
      const token = createMockToken();
      const signer = new RealFacilitatorAztecSigner(createMockAccount(), createMockNode("success"), token);
      await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      expect(token.methods.prepare_private_balance_increase).toHaveBeenCalled();
    });

    it("extracts commitment from v4.1.0 simulate result shape", async () => {
      // v4.1.0: simulate() returns { result: { commitment }, offchainEffects, offchainMessages }
      const signer = createSigner("success");
      const result = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      expect(result.commitment).toBe(MOCK_COMMITMENT);
      expect(result.prepareTxHash).toBe(TX_HASH);
    });

    it("prefers offchainMessages commitment when available", async () => {
      const signer = createSigner("success", {
        offchainMessages: [{ payload: "0xdeadbeef" }],
      });
      const result = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      expect(result.commitment).toBe("0xdeadbeef");
      expect(result.offchainMessage).toBe(JSON.stringify([{ payload: "0xdeadbeef" }]));
      expect(result.prepareTxHash).toBe(TX_HASH);
    });

    it("falls back to simulate when offchainMessages is empty", async () => {
      // This is the current v4.1.0 behavior: offchainMessages: []
      const signer = createSigner("success", {
        offchainMessages: [],
      });
      const result = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      expect(result.commitment).toBe(MOCK_COMMITMENT);
      expect(result.offchainMessage).toBeUndefined();
    });

    it("handles v4.0.x simulate result (commitment at top level)", async () => {
      const signer = createSigner("success", {
        simulateResult: { commitment: "0xlegacy_commitment" },
      });
      const result = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      expect(result.commitment).toBe("0xlegacy_commitment");
    });

    it("handles v4.0.x simulate result (raw Field value)", async () => {
      const signer = createSigner("success", {
        simulateResult: "0xraw_field_value",
      });
      const result = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      expect(result.commitment).toBe("0xraw_field_value");
    });

    it("includes offchainMessage and prepareTxHash when offchain data present", async () => {
      const offchainMessages = [
        { payload: "0xcafe", recipient: SERVER_ADDRESS_STR, anchorBlockTimestamp: 12345 },
      ];
      const signer = createSigner("success", { offchainMessages });
      const result = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      expect(result.commitment).toBe("0xcafe");
      expect(result.offchainMessage).toBe(JSON.stringify(offchainMessages));
      expect(result.prepareTxHash).toBe(TX_HASH);
    });

    it("handles JSON payload in offchainMessages", async () => {
      const signer = createSigner("success", {
        offchainMessages: [{ payload: JSON.stringify({ commitment: "0xjsoncommit" }) }],
      });
      const result = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      expect(result.commitment).toBe("0xjsoncommit");
    });
  });
});
