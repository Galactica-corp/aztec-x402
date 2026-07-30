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
 * Verification flow:
 * - Verification looks up the completion log keyed by the commitment via
 *   the node's `getPrivateLogsByTags` / `getPublicLogsByTags`
 *   methods. The recovered log binds the txHash to the commitment and
 *   yields the actual transferred amount.
 */
import { describe, it, expect, jest } from "bun:test";

// Polyfill for @aztec/foundation which calls expect.addEqualityTesters at module load.
// MUST run before any @aztec/* module import to avoid TypeError at load time.
if (!Reflect.get(expect, "addEqualityTesters")) {
  Reflect.set(expect, "addEqualityTesters", () => {});
}

import type { Fr as FrType } from "@aztec/aztec.js/fields";
import type { TxHash as TxHashType } from "@aztec/aztec.js/tx";

const { Fr } = await import("@aztec/aztec.js/fields");
const { TxHash } = await import("@aztec/aztec.js/tx");
const { AztecAddress } = await import("@aztec/aztec.js/addresses");
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
const OTHER_TX_HASH =
  "0x0fedcba987654321fedcba987654321fedcba987654321fedcba987654321fed";
const MOCK_COMMITMENT =
  "0x01010101010101010101010101010101010101010101010101010101010101ab";
const MOCK_STORAGE_SLOT =
  "0x0000000000000000000000000000000000000000000000000000000000000007";
const REQUIRED_AMOUNT = 100_000n;

/** Stringify-only stub — enough for values the signer merely formats. */
function mockAztecAddress(addrStr: string) {
  return { toString: () => addrStr };
}

interface CompletionLogFixture {
  txHash: TxHashType;
  storageSlot: FrType;
  value: bigint;
}

interface MockNodeOptions {
  status?: string;
  /** Logs returned on the private channel. Defaults to a single valid log. */
  privateLogs?: CompletionLogFixture[];
  /** Logs returned on the public-fallback channel. Defaults to empty. */
  publicLogs?: CompletionLogFixture[];
  /** If set, getTxReceipt rejects with this error */
  txReceiptError?: Error;
}

function logToLogResult(log: CompletionLogFixture) {
  // Mirrors the on-chain shape: logData[0] is the tag (unused here),
  // logData[1] is the storage slot, logData[2] is the value.
  return {
    txHash: log.txHash,
    logData: [Fr.random(), log.storageSlot, new Fr(log.value)],
  };
}

function defaultCompletionLog(): CompletionLogFixture {
  return {
    txHash: TxHash.fromString(TX_HASH),
    storageSlot: Fr.fromString(MOCK_STORAGE_SLOT),
    value: REQUIRED_AMOUNT,
  };
}

function createMockNode(opts?: string | MockNodeOptions) {
  const options: MockNodeOptions =
    typeof opts === "string" ? { status: opts } : opts ?? {};

  const privateLogs = (options.privateLogs ?? [defaultCompletionLog()]).map(
    logToLogResult,
  );
  const publicLogs = (options.publicLogs ?? []).map(logToLogResult);

  return {
    getTxReceipt: options.txReceiptError
      ? jest.fn().mockRejectedValue(options.txReceiptError)
      : jest.fn().mockResolvedValue({
          status: options.status ?? "proposed",
          executionResult: "success",
        }),
    getPrivateLogsByTags: jest.fn().mockResolvedValue([privateLogs]),
    getPublicLogsByTags: jest.fn().mockResolvedValue([publicLogs]),
  };
}

function createMockAccount(addr = SERVER_ADDRESS_STR) {
  // The signer passes this straight into the token ABI and into `from`,
  // so it has to be a real AztecAddress, not a stringify-only stub.
  return { address: AztecAddress.fromStringUnsafe(addr) };
}

interface MockTokenOptions {
  /** What simulate() returns */
  simulateResult?: unknown;
  /** What send() returns (v4.1.0 shape) */
  offchainMessages?: Array<{ payload: string; recipient?: string; anchorBlockTimestamp?: number }>;
}

function isMockTokenOptions(opts: unknown): opts is MockTokenOptions {
  return (
    opts != null &&
    typeof opts === "object" &&
    ("offchainMessages" in opts || "simulateResult" in opts)
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
  let simulateResult: unknown = {
    result: MOCK_COMMITMENT,
    offchainEffects: [],
    offchainMessages: [],
  };
  let offchainMessages:
    | Array<{ payload: string; recipient?: string; anchorBlockTimestamp?: number }>
    | undefined;

  if (isMockTokenOptions(opts)) {
    if (opts.simulateResult !== undefined) simulateResult = opts.simulateResult;
    offchainMessages = opts.offchainMessages;
  } else if (opts !== undefined) {
    // Legacy: raw value = simulate result
    simulateResult = opts;
  }

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
    },
  };
}

function createSigner(
  nodeOpts?: string | MockNodeOptions,
  tokenOpts?: unknown | MockTokenOptions,
) {
  return new RealFacilitatorAztecSigner(
    createMockAccount(),
    createMockNode(nodeOpts),
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
      const result = await verifyPrepared(createSigner("proposed"));
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
      const signer = createSigner({ txReceiptError: new Error("node unavailable") });
      const prepared = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      const result = await signer.verifyPayment(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        REQUIRED_AMOUNT,
        prepared.commitment,
      );
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("node unavailable");
    });
  });

  describe("verifyPayment — completion log lookup", () => {
    it("returns isValid with the recovered amount when the private log matches", async () => {
      const signer = createSigner({
        privateLogs: [
          {
            txHash: TxHash.fromString(TX_HASH),
            storageSlot: Fr.fromString(MOCK_STORAGE_SLOT),
            value: 250_000n,
          },
        ],
      });
      const prepared = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      const result = await signer.verifyPayment(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        100_000n,
        prepared.commitment,
      );
      expect(result.isValid).toBe(true);
      expect(result.amountFound).toBe(250_000n);
    });

    it("falls back to the public log channel when the private channel is empty", async () => {
      const signer = createSigner({
        privateLogs: [],
        publicLogs: [
          {
            txHash: TxHash.fromString(TX_HASH),
            storageSlot: Fr.fromString(MOCK_STORAGE_SLOT),
            value: 175_000n,
          },
        ],
      });
      const prepared = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      const result = await signer.verifyPayment(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        150_000n,
        prepared.commitment,
      );
      expect(result.isValid).toBe(true);
      expect(result.amountFound).toBe(175_000n);
    });

    it("rejects when no completion log is found on either channel", async () => {
      const signer = createSigner({ privateLogs: [], publicLogs: [] });
      const prepared = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      const result = await signer.verifyPayment(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        REQUIRED_AMOUNT,
        prepared.commitment,
      );
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("no completion log found");
    });

    it("rejects when the completion log txHash does not match the buyer's tx", async () => {
      const signer = createSigner({
        privateLogs: [
          {
            txHash: TxHash.fromString(OTHER_TX_HASH),
            storageSlot: Fr.fromString(MOCK_STORAGE_SLOT),
            value: REQUIRED_AMOUNT,
          },
        ],
      });
      const prepared = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      const result = await signer.verifyPayment(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        REQUIRED_AMOUNT,
        prepared.commitment,
      );
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("completion log belongs to tx");
    });

    it("rejects when more than one completion log matches (commitment ambiguity)", async () => {
      const log = {
        txHash: TxHash.fromString(TX_HASH),
        storageSlot: Fr.fromString(MOCK_STORAGE_SLOT),
        value: REQUIRED_AMOUNT,
      };
      const signer = createSigner({ privateLogs: [log, log] });
      const prepared = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      const result = await signer.verifyPayment(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        REQUIRED_AMOUNT,
        prepared.commitment,
      );
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("no completion log found");
    });
  });

  describe("verifyPayment — amount verification", () => {
    it("returns the recovered amount when value >= required", async () => {
      const signer = createSigner({
        privateLogs: [
          {
            txHash: TxHash.fromString(TX_HASH),
            storageSlot: Fr.fromString(MOCK_STORAGE_SLOT),
            value: 200_000n,
          },
        ],
      });
      const prepared = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      const result = await signer.verifyPayment(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        100_000n,
        prepared.commitment,
      );
      expect(result.isValid).toBe(true);
      expect(result.amountFound).toBe(200_000n);
    });

    it("rejects when the recovered value is less than required, exposing what was received", async () => {
      const signer = createSigner({
        privateLogs: [
          {
            txHash: TxHash.fromString(TX_HASH),
            storageSlot: Fr.fromString(MOCK_STORAGE_SLOT),
            value: 50_000n,
          },
        ],
      });
      const prepared = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      const result = await signer.verifyPayment(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        100_000n,
        prepared.commitment,
      );
      expect(result.isValid).toBe(false);
      expect(result.amountFound).toBe(50_000n);
      expect(result.error).toContain("insufficient payment");
    });

    it("accepts when the recovered value exactly equals required", async () => {
      const signer = createSigner({
        privateLogs: [
          {
            txHash: TxHash.fromString(TX_HASH),
            storageSlot: Fr.fromString(MOCK_STORAGE_SLOT),
            value: 100_000n,
          },
        ],
      });
      const prepared = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      const result = await signer.verifyPayment(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        100_000n,
        prepared.commitment,
      );
      expect(result.isValid).toBe(true);
      expect(result.amountFound).toBe(100_000n);
    });

    it("rejects when no commitment provided", async () => {
      const result = await createSigner("proposed").verifyPayment(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        100_000n,
      );
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("commitment");
    });

    it("rejects a commitment that is structurally non-zero but exceeds the field modulus", async () => {
      const invalidCommitment = "0x" + "ff".repeat(32);
      const result = await createSigner("proposed").verifyPayment(
        TX_HASH,
        TOKEN_ADDRESS_STR,
        REQUIRED_AMOUNT,
        invalidCommitment,
      );
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("invalid commitment");
    });

    it("rejects wrong token address when the contract address is known", async () => {
      const signer = createSigner("proposed");
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
      const signer = new RealFacilitatorAztecSigner(createMockAccount(), createMockNode("proposed"), token);
      await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      expect(token.methods.initialize_transfer_commitment).toHaveBeenCalled();
    });

    it("extracts commitment from v4.1.0 simulate result shape", async () => {
      // v4.1.0: simulate() returns { result: Field, offchainEffects, offchainMessages }
      const signer = createSigner("proposed");
      const result = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      expect(result.commitment).toBe(MOCK_COMMITMENT);
      expect(result.prepareTxHash).toBe(TX_HASH);
    });

    it("forwards offchainMessages without using ciphertext as commitment", async () => {
      const signer = createSigner("proposed", {
        offchainMessages: [{ payload: "0xdeadbeef" }],
      });
      const result = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      expect(result.commitment).toBe(MOCK_COMMITMENT);
      expect(result.offchainMessage).toBe(JSON.stringify([{ payload: "0xdeadbeef" }]));
      expect(result.prepareTxHash).toBe(TX_HASH);
    });

    it("falls back to simulate when offchainMessages is empty", async () => {
      // This is the current v4.1.0 behavior: offchainMessages: []
      const signer = createSigner("proposed", {
        offchainMessages: [],
      });
      const result = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      expect(result.commitment).toBe(MOCK_COMMITMENT);
      expect(result.offchainMessage).toBeUndefined();
    });

    it("handles raw Field simulate result (no wrapper)", async () => {
      const rawCommitment = "0x" + "12".repeat(31) + "01";
      const signer = createSigner("proposed", {
        simulateResult: rawCommitment,
      });
      const result = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      expect(result.commitment).toBe(rawCommitment);
    });

    it("includes offchainMessage and prepareTxHash when offchain data present", async () => {
      const offchainMessages = [
        { payload: "0xcafe", recipient: SERVER_ADDRESS_STR, anchorBlockTimestamp: 12345 },
      ];
      const signer = createSigner("proposed", { offchainMessages });
      const result = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      expect(result.commitment).toBe(MOCK_COMMITMENT);
      expect(result.offchainMessage).toBe(JSON.stringify(offchainMessages));
      expect(result.prepareTxHash).toBe(TX_HASH);
    });

    it("does not parse JSON payload in offchainMessages as a commitment", async () => {
      const signer = createSigner("proposed", {
        offchainMessages: [{ payload: JSON.stringify({ commitment: "0xjsoncommit" }) }],
      });
      const result = await signer.prepareCommitment(TOKEN_ADDRESS_STR, CLIENT_ADDRESS_STR);
      expect(result.commitment).toBe(MOCK_COMMITMENT);
    });
  });
});
