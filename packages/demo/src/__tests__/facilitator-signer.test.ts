/**
 * Unit tests for RealFacilitatorAztecSigner.
 *
 * These tests verify commitment creation and payment verification used in
 * the demo server. They use mock node/token objects to test without a
 * running Aztec sandbox.
 *
 * v4.1.0 API changes (confirmed on sandbox 4.1.0-nightly.20260314):
 * - send() returns { receipt, offchainEffects, offchainMessages }
 * - simulate() returns { result: Field, offchainEffects, offchainMessages }
 * - txHash is on receipt, not top-level
 * - offchainMessages is present but currently empty [] for initialize_transfer_commitment
 *
 * NOTE: We avoid importing AztecAddress directly because @aztec/foundation
 * validates field elements at module load time and our synthetic test addresses
 * exceed the BN254 field modulus. Instead, we use duck-typed mocks.
 */
import { describe, it, expect, jest } from "bun:test";

// Polyfill for @aztec/foundation which calls expect.addEqualityTesters at module load
if (!Reflect.get(expect, "addEqualityTesters")) {
  Reflect.set(expect, "addEqualityTesters", () => {});
}

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
const VALID_TX_EFFECT = {
  noteHashes: ["0x0abababababababababababababababababababababababababababababababab"],
  nullifiers: ["0x0efefefefefefefefefefefefefefefefefefefefefefefefefefefefefef"],
};

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
      : jest.fn().mockResolvedValue(
          "txEffect" in options ? options.txEffect : VALID_TX_EFFECT,
        ),
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
  /** balance_of_private return values: [before, after] */
  balances?: [bigint, bigint];
  /** If true, balance_of_private throws */
  balanceError?: boolean;
}

function isMockTokenOptions(opts: unknown): opts is MockTokenOptions {
  return (
    opts != null &&
    typeof opts === "object" &&
    (
      "offchainMessages" in opts ||
      "simulateResult" in opts ||
      "balances" in opts ||
      "balanceError" in opts
    )
  );
}

/**
 * Create a mock token contract.
 *
 * Default simulate result uses v4.1.0 shape: { result: Field, offchainEffects: [], offchainMessages: [] }
 * AIP-20's initialize_transfer_commitment returns Field directly (not nested { commitment }).
 * Default send result uses v4.1.0 shape: { receipt: { txHash }, offchainEffects: [], offchainMessages: [] }
 */
function createMockToken(opts?: unknown | MockTokenOptions) {
  // v4.1.0 default simulate result — AIP-20 returns Field directly
  let simulateResult: unknown = {
    result: MOCK_COMMITMENT,
    offchainEffects: [],
    offchainMessages: [],
  };
  let offchainMessages: Array<{ payload: string; recipient?: string; anchorBlockTimestamp?: number }> | undefined;

  let balances: [bigint, bigint] = [0n, REQUIRED_AMOUNT];
  let balanceError = false;

  if (isMockTokenOptions(opts)) {
    if (opts.simulateResult !== undefined) simulateResult = opts.simulateResult;
    offchainMessages = opts.offchainMessages;
    balances = opts.balances ?? balances;
    balanceError = opts.balanceError ?? false;
  } else if (opts !== undefined) {
    // Legacy: raw value = simulate result
    simulateResult = opts;
  }

  // balance_of_private mock: returns balances[0] first call, balances[1] second call
  let balanceCallCount = 0;
  const balanceOfPrivate = balanceError
    ? jest.fn().mockReturnValue({
        simulate: jest.fn().mockRejectedValue(new Error("balance_of_private unavailable")),
      })
    : jest.fn().mockReturnValue({
        simulate: jest.fn().mockImplementation(() => {
          const idx = Math.min(balanceCallCount++, balances.length - 1);
          return Promise.resolve(balances[idx]);
        }),
      });

  return {
    address: mockAztecAddress(TOKEN_ADDRESS_STR),
    methods: {
      initialize_transfer_commitment: jest.fn().mockReturnValue({
        simulate: jest.fn().mockResolvedValue(simulateResult),
        send: jest.fn().mockResolvedValue({
          // v4.1.0 shape: txHash on receipt
          receipt: { txHash: { toString: () => TX_HASH }, status: "success" },
          offchainEffects: [],
          offchainMessages: offchainMessages ?? [],
        }),
      }),
      balance_of_private: balanceOfPrivate,
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

async function verifyPrepared(
  signer: InstanceType<typeof RealFacilitatorAztecSigner>,
  amount: bigint = REQUIRED_AMOUNT,
) {
  const prepared = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
  return signer.verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, amount, prepared.commitment);
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
      const result = await verifyPrepared(createSigner("success"));
      expect(result.isValid).toBe(true);
    });

    it("accepts tx with status 'proposed'", async () => {
      const result = await verifyPrepared(createSigner("proposed"));
      expect(result.isValid).toBe(true);
    });

    it("accepts tx with status 'checkpointed'", async () => {
      const result = await verifyPrepared(createSigner("checkpointed"));
      expect(result.isValid).toBe(true);
    });

    it("accepts tx with status 'proven'", async () => {
      const result = await verifyPrepared(createSigner("proven"));
      expect(result.isValid).toBe(true);
    });

    it("accepts tx with status 'finalized'", async () => {
      const result = await verifyPrepared(createSigner("finalized"));
      expect(result.isValid).toBe(true);
    });

    it("rejects a dropped transaction", async () => {
      const result = await verifyPrepared(createSigner("dropped"));
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("dropped");
    });

    it("rejects a reverted transaction", async () => {
      const result = await verifyPrepared(createSigner("reverted"));
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("reverted");
    });

    it("handles node errors gracefully", async () => {
      const node = {
        getTxReceipt: jest.fn().mockRejectedValue(new Error("node unavailable")),
        getTxEffect: jest.fn().mockResolvedValue(null),
      };
      const signer = new RealFacilitatorAztecSigner(createMockAccount(), node, createMockToken());
      const prepared = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      const result = await signer.verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, REQUIRED_AMOUNT, prepared.commitment);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("node unavailable");
    });
  });

  describe("verifyPayment — tx effect validation", () => {
    it("rejects transaction with no note hashes", async () => {
      const signer = createSigner({
        status: "success",
        txEffect: { noteHashes: [], nullifiers: [] },
      });
      const result = await verifyPrepared(signer);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("no private notes");
    });

    it("rejects transaction where all note hashes are zero", async () => {
      const signer = createSigner({
        status: "success",
        txEffect: { noteHashes: ["0", "0x0", "0"], nullifiers: [] },
      });
      const result = await verifyPrepared(signer);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("no private notes");
    });

    it("rejects transaction where all note hashes are Fr.ZERO", async () => {
      const FR_ZERO = "0x" + "0".repeat(64);
      const signer = createSigner({
        status: "success",
        txEffect: { noteHashes: [FR_ZERO, FR_ZERO], nullifiers: [] },
      });
      const result = await verifyPrepared(signer);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("no private notes");
    });

    it("accepts transaction with non-zero note hashes and nullifiers", async () => {
      const signer = createSigner({
        status: "success",
        txEffect: VALID_TX_EFFECT,
      });
      const result = await verifyPrepared(signer);
      expect(result.isValid).toBe(true);
    });

    it("handles wrapped SDK shape (IndexedTxEffect with data property)", async () => {
      const signer = createSigner({
        status: "success",
        txEffect: {
          data: VALID_TX_EFFECT,
        },
      });
      const result = await verifyPrepared(signer);
      expect(result.isValid).toBe(true);
    });

    it("rejects transaction with notes but no nullifiers", async () => {
      const signer = createSigner({
        status: "success",
        txEffect: {
          noteHashes: VALID_TX_EFFECT.noteHashes,
          nullifiers: [],
        },
      });
      const result = await verifyPrepared(signer);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("no nullifiers");
    });

    it("rejects when getTxEffect is not available", async () => {
      const signer = createSigner({
        status: "success",
        txEffectError: true,
      });
      const result = await verifyPrepared(signer);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("effects unavailable");
    });

    it("rejects when getTxEffect returns null", async () => {
      const signer = createSigner({
        status: "success",
        txEffect: null,
      });
      const result = await verifyPrepared(signer);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("effects unavailable");
    });
  });

  describe("verifyPayment — amount verification", () => {
    it("verifies actual amount via balance difference (keyed by commitment)", async () => {
      const token = createMockToken({ balances: [500_000n, 600_000n] });
      const signer = new RealFacilitatorAztecSigner(createMockAccount(), createMockNode("success"), token);
      // prepareCommitment snapshots balance (500_000), keyed by commitment
      const prepared = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      // verifyPayment checks balance again (600_000), diff = 100_000
      const result = await signer.verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, 100_000n, prepared.commitment);
      expect(result.isValid).toBe(true);
      expect(result.amountFound).toBe(100_000n);
    });

    it("rejects when actual amount is less than required", async () => {
      const token = createMockToken({ balances: [500_000n, 550_000n] });
      const signer = new RealFacilitatorAztecSigner(createMockAccount(), createMockNode("success"), token);
      const prepared = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      const result = await signer.verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, 100_000n, prepared.commitment);
      expect(result.isValid).toBe(false);
      expect(result.amountFound).toBe(50_000n);
      expect(result.error).toContain("insufficient payment");
    });

    it("accepts when actual amount exceeds required", async () => {
      const token = createMockToken({ balances: [500_000n, 700_000n] });
      const signer = new RealFacilitatorAztecSigner(createMockAccount(), createMockNode("success"), token);
      const prepared = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      const result = await signer.verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, 100_000n, prepared.commitment);
      expect(result.isValid).toBe(true);
      expect(result.amountFound).toBe(200_000n);
    });

    it("rejects when balance_of_private is unavailable", async () => {
      const token = createMockToken({ balanceError: true });
      const signer = new RealFacilitatorAztecSigner(createMockAccount(), createMockNode("success"), token);
      const prepared = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      const result = await signer.verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, 100_000n, prepared.commitment);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("amount snapshot unavailable");
    });

    it("rejects when no commitment provided", async () => {
      const result = await createSigner("success").verifyPayment(TX_HASH, TOKEN_ADDRESS_STR, 100_000n);
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("commitment");
    });

    it("rejects wrong token address when the contract address is known", async () => {
      const signer = createSigner("success");
      const prepared = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      const result = await signer.verifyPayment(
        TX_HASH,
        "0x" + "ee".repeat(32),
        100_000n,
        prepared.commitment,
      );
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("wrong token");
    });
  });

  describe("prepareCommitment", () => {
    it("calls initialize_transfer_commitment with facilitator and completer addresses", async () => {
      const token = createMockToken();
      const signer = new RealFacilitatorAztecSigner(createMockAccount(), createMockNode("success"), token);
      await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      expect(token.methods.initialize_transfer_commitment).toHaveBeenCalled();
    });

    it("extracts commitment from v4.1.0 simulate result shape", async () => {
      // v4.1.0: simulate() returns { result: Field, offchainEffects, offchainMessages }
      const signer = createSigner("success");
      const result = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      expect(result.commitment).toBe(MOCK_COMMITMENT);
      expect(result.prepareTxHash).toBe(TX_HASH);
    });

    it("forwards offchainMessages without using ciphertext as commitment", async () => {
      const signer = createSigner("success", {
        offchainMessages: [{ payload: "0xdeadbeef" }],
      });
      const result = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      expect(result.commitment).toBe(MOCK_COMMITMENT);
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

    it("handles raw Field simulate result (no wrapper)", async () => {
      const rawCommitment = "0x" + "12".repeat(32);
      const signer = createSigner("success", {
        simulateResult: rawCommitment,
      });
      const result = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      expect(result.commitment).toBe(rawCommitment);
    });

    it("includes offchainMessage and prepareTxHash when offchain data present", async () => {
      const offchainMessages = [
        { payload: "0xcafe", recipient: SERVER_ADDRESS_STR, anchorBlockTimestamp: 12345 },
      ];
      const signer = createSigner("success", { offchainMessages });
      const result = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      expect(result.commitment).toBe(MOCK_COMMITMENT);
      expect(result.offchainMessage).toBe(JSON.stringify(offchainMessages));
      expect(result.prepareTxHash).toBe(TX_HASH);
    });

    it("does not parse JSON payload in offchainMessages as a commitment", async () => {
      const signer = createSigner("success", {
        offchainMessages: [{ payload: JSON.stringify({ commitment: "0xjsoncommit" }) }],
      });
      const result = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      expect(result.commitment).toBe(MOCK_COMMITMENT);
    });
  });
});
