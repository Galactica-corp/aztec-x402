/**
 * Paying one's own fees: a tx whose fee limit exceeds the payer's Fee Juice is refused before proving (the node
 * would refuse it after the handoff, where an exit reads as possibly still landing); the merchant warns when its
 * Fee Juice runs low; and a burn the node dropped is settled once it can no longer be included.
 */
import { describe, expect, test } from "bun:test";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { NO_FROM } from "@aztec-labs/aztec.js/account";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { TxHash, TxStatus } from "@aztec-labs/aztec.js/tx";
import { Gas, GasFees } from "@aztec-labs/stdlib/gas";
import { memoryStateStore } from "@galactica-net/x402-middleware";
import { handedFate, type HandedFateNode } from "../commands/usdc.js";
import {
  assertCoversFeeLimit,
  formatFeeJuice,
  InsufficientFeeJuiceError,
  TYPICAL_TX_L2_GAS,
  typicalTxFeeLimit,
} from "../aztec/fee-limit.js";
import { MerchantJobs } from "../aztec/merchant-jobs.js";
import { PXEWallet } from "../aztec/pxe-wallet.js";
import { handedBurnsOf, type UsdcWithdrawalRecord } from "../fund/usdc.js";

const FJ = 10n ** 18n;
const ADDRESS = AztecAddress.fromStringUnsafe(`0x${"1f".repeat(32)}`);
const HASH = `0x${"29".repeat(32)}`;
const FEE_PER_L2_GAS = 2_492_018_145_470n; // mainnet, 2026-11-20

describe("the fee limit check", () => {
  test("refuses a balance below the fee limit with a typed error that says nothing was sent", () => {
    expect(() => assertCoversFeeLimit(ADDRESS, 3n * FJ, 3n * FJ)).not.toThrow();
    let error: unknown;
    try {
      assertCoversFeeLimit(ADDRESS, 2_117_861_942_123_593_554n, 3_100_000_000_000_000_000n);
    } catch (e) {
      error = e;
    }
    if (!(error instanceof InsufficientFeeJuiceError)) throw new Error(`expected InsufficientFeeJuiceError, got ${String(error)}`);
    const e = error;
    expect(e.code).toBe("insufficient_fee_juice");
    expect(e.details).toEqual({ address: ADDRESS.toString(), balance: "2.1178", needed: "3.1", txSubmitted: false });
    expect(e.message).toContain("Nothing was sent");
  });

  test("a typical tx's fee limit pads the node's minimum fee as the wallet does", async () => {
    const node = { getCurrentMinFees: async () => new GasFees(0, FEE_PER_L2_GAS) };
    const limit = await typicalTxFeeLimit(node);
    expect(limit).toBe((FEE_PER_L2_GAS * 3n * TYPICAL_TX_L2_GAS) / 2n);
    // About 4.1 FEE at today's fees: more than the 2.12 the merchant held when its exit was dropped.
    expect(formatFeeJuice(limit)).toBe("4.1118");
  });

  test("formats whole tokens to four decimals", () => {
    expect(formatFeeJuice(0n)).toBe("0");
    expect(formatFeeJuice(25n * FJ)).toBe("25");
    expect(formatFeeJuice(1_892_179_941_167_324_171n)).toBe("1.8921");
  });
});

/** A PXEWallet without a PXE: only what completeFeeOptions reads. */
function walletWith(balance: bigint): PXEWallet {
  const wallet: PXEWallet = Object.create(PXEWallet.prototype);
  Object.assign(wallet, {
    minFeePadding: 0.5,
    log: { debug: () => {}, verbose: () => {}, info: () => {} },
    getMaxTxGasLimits: async () => new Gas(6_000_000, 6_000_000),
    aztecNode: {
      getPredictedMinFees: async () => [new GasFees(0, FEE_PER_L2_GAS)],
      getCurrentMinFees: async () => new GasFees(0, FEE_PER_L2_GAS),
      getPublicStorageAt: async () => new Fr(balance),
    },
  });
  return wallet;
}

describe("the wallet", () => {
  const limits = { gasLimits: new Gas(1_000_000, 830_000), teardownGasLimits: Gas.empty() };
  // Protected: reached by element access, as the wallet itself reaches it right before proving.
  const complete = (w: PXEWallet, config: Parameters<PXEWallet["completeFeeOptions"]>[0]) => w["completeFeeOptions"](config);

  test("refuses before proving a tx the sender pays from Fee Juice it cannot cover", async () => {
    // 830k L2 gas at 1.5 × the minimum fee is 3.1 FEE.
    await expect(complete(walletWith(2n * FJ), { from: ADDRESS, gasSettings: limits })).rejects.toBeInstanceOf(InsufficientFeeJuiceError);
    await expect(complete(walletWith(4n * FJ), { from: ADDRESS, gasSettings: limits })).resolves.toBeDefined();
  });

  test("checks neither simulations, nor txs another payer pays, nor txs without a sender", async () => {
    const poor = walletWith(0n);
    await expect(complete(poor, { from: ADDRESS, forEstimation: true })).resolves.toBeDefined();
    await expect(complete(poor, { from: ADDRESS, feePayer: AztecAddress.fromStringUnsafe(`0x${"2e".repeat(32)}`), gasSettings: limits })).resolves.toBeDefined();
    await expect(complete(poor, { from: NO_FROM, gasSettings: limits })).resolves.toBeDefined();
  });
});

describe("the merchant's status", () => {
  test("carries extra warnings, and a failure to read them as a warning", async () => {
    const base = { store: memoryStateStore(), receive: async () => ({ isValid: true }) };
    const low = new MerchantJobs({ ...base, extraWarnings: async () => ["Fee Juice is low"] });
    expect((await low.status()).warnings).toEqual(["Fee Juice is low"]);
    const broken = new MerchantJobs({ ...base, extraWarnings: async () => Promise.reject(new Error("node down")) });
    expect((await broken.status()).warnings).toEqual(["Could not check: node down"]);
  });
});

describe("a dropped burn", () => {
  const record = (over: Partial<UsdcWithdrawalRecord> = {}): UsdcWithdrawalRecord => ({
    id: "w1",
    createdAt: "2026-11-20T10:06:39.717Z",
    from: ADDRESS.toString(),
    recipient: "0x116bf50fd3bb8fa726fdb7fcff4942dd42666174",
    amount: "1000000",
    asMerchant: true,
    status: "unconfirmed",
    l2TxHash: HASH,
    ...over,
  });
  const legacyError =
    `Exit ${HASH} was handed to the node, which then reported a fee rejection this client cannot verify. It can be ` +
    "included until 2026-11-21T09:06:59.000Z: do not exit again; resume it from its hash until it lands or a finalized block passes that time.";
  const node = (finalizedAt: bigint, status: TxStatus = TxStatus.DROPPED): HandedFateNode => ({
    getBlock: async () => ({ header: { globalVariables: { timestamp: finalizedAt } } }),
    getTxReceipt: async () => ({ status }),
  });
  const INCLUDE_BY = 1_795_252_019n; // 2026-11-21T09:06:59Z

  test("records written before `handed` was kept give their expiry in the SDK's message", () => {
    expect(handedBurnsOf(record({ error: legacyError }))).toEqual([{ txHash: HASH, includeBy: INCLUDE_BY.toString() }]);
    expect(handedBurnsOf(record({ handed: [{ txHash: HASH, includeBy: "5" }] }))).toEqual([{ txHash: HASH, includeBy: "5" }]);
    expect(handedBurnsOf(record({ error: "gave no confirmation" }))).toBeUndefined();
  });

  test("expires only once a finalized block is past its expiry, and never while the tx is included or pending", async () => {
    const r = record({ error: legacyError });
    const n = node;
    expect(await handedFate(r, n(INCLUDE_BY))).toEqual({ state: "dropped", until: "2026-11-21T09:06:59.000Z" });
    expect(await handedFate(r, n(INCLUDE_BY + 1n))).toEqual({ state: "expired" });
    expect(await handedFate(r, n(INCLUDE_BY + 1n, TxStatus.PENDING))).toEqual({ state: "open" });
    expect(await handedFate(r, n(INCLUDE_BY + 1n, TxStatus.CHECKPOINTED))).toEqual({ state: "open" });
    expect(await handedFate(record(), n(INCLUDE_BY + 1n))).toEqual({ state: "open" });
  });

  test("with several handed txs, waits for the last expiry and for every one to be dropped", async () => {
    const other = `0x${"30".repeat(32)}`;
    const r = record({ handed: [{ txHash: HASH, includeBy: "100" }, { txHash: other, includeBy: "200" }] });
    const n = (f: bigint, pendingHash?: string): HandedFateNode => ({
      getBlock: async () => ({ header: { globalVariables: { timestamp: f } } }),
      getTxReceipt: async (h: TxHash) => ({ status: h.toString() === pendingHash ? TxStatus.PENDING : TxStatus.DROPPED }),
    });
    expect((await handedFate(r, n(150n))).state).toBe("dropped");
    expect((await handedFate(r, n(201n))).state).toBe("expired");
    expect((await handedFate(r, n(201n, other))).state).toBe("open");
  });
});
