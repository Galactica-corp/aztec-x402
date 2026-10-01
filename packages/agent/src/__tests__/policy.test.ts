import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { appendLedger, checkPayment, parseAmount, readLedger, spentLast24h } from "../policy.js";
import { PolicyError, UsageError } from "../errors.js";
import type { NetworkConfig, TokenInfo } from "../networks.js";

const USDC: TokenInfo = {
  symbol: "USDC",
  name: "USDC",
  address: "0x2bb09ca02aeabb84fbe69537a0bf4b5ed57112466dc4666f9639157fe8dcfcf7",
  decimals: 6,
};

const network: NetworkConfig = {
  name: "testnet",
  caip2: "aztec:testnet",
  nodeUrl: "http://node",
  proverEnabled: true,
  sponsoredFees: true,
  l1ChainId: 11155111,
  l1ChainName: "Sepolia",
  l1RpcUrl: "http://l1",
  tokens: [USDC],
};

const MERCHANT = "0x0dd252a7d60fcad329acac8ec80314194ab0ec3c99323263b3417651153c056c";
const policy = { maxPerPayment: "1", dailyLimit: "2" };

function requirement(amount: string, overrides: Record<string, string> = {}) {
  return { network: "aztec:testnet", asset: USDC.address, amount, payTo: MERCHANT, ...overrides };
}

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "x402-agent-"));
});

describe("checkPayment", () => {
  test("accepts a price within every limit and returns the token", () => {
    expect(checkPayment(requirement("10000"), { maxAmount: "0.05" }, policy, network, dataDir)).toBe(USDC);
  });

  test("accepts a price exactly at --max-amount", () => {
    expect(() => checkPayment(requirement("50000"), { maxAmount: "0.05" }, policy, network, dataDir)).not.toThrow();
  });

  test("refuses a price above --max-amount", () => {
    expect(() => checkPayment(requirement("50001"), { maxAmount: "0.05" }, policy, network, dataDir)).toThrow(
      PolicyError,
    );
  });

  test("refuses a price above the per-payment policy even with a high cap", () => {
    expect(() => checkPayment(requirement("1500000"), { maxAmount: "5" }, policy, network, dataDir)).toThrow(
      /per-payment policy limit/,
    );
  });

  test("refuses an unknown asset", () => {
    const req = requirement("1", { asset: "0x" + "11".repeat(32) });
    expect(() => checkPayment(req, { maxAmount: "1" }, policy, network, dataDir)).toThrow(/unknown asset/);
  });

  test("refuses a challenge for another network", () => {
    const req = requirement("1", { network: "aztec:sandbox" });
    expect(() => checkPayment(req, { maxAmount: "1" }, policy, network, dataDir)).toThrow(/aztec:sandbox/);
  });

  test("enforces --expect-pay-to and --expect-asset", () => {
    expect(() =>
      checkPayment(requirement("1"), { maxAmount: "1", expectPayTo: "0x" + "22".repeat(32) }, policy, network, dataDir),
    ).toThrow(/expected/);
    expect(() =>
      checkPayment(requirement("1"), { maxAmount: "1", expectPayTo: MERCHANT.toUpperCase().replace("0X", "0x") }, policy, network, dataDir),
    ).not.toThrow();
    expect(() => checkPayment(requirement("1"), { maxAmount: "1", expectAsset: "usdc" }, policy, network, dataDir)).not.toThrow();
    expect(() => checkPayment(requirement("1"), { maxAmount: "1", expectAsset: "DAI" }, policy, network, dataDir)).toThrow(
      /expected DAI/,
    );
  });

  test("counts pending and paid entries toward the 24h limit, not failed ones", () => {
    const base = { url: "u", network: "aztec:testnet", asset: USDC.address, token: "USDC", amount: "", payTo: MERCHANT };
    appendLedger(dataDir, { ...base, id: "a", status: "paid", amountBaseUnits: "900000" });
    appendLedger(dataDir, { ...base, id: "b", status: "pending", amountBaseUnits: "900000" });
    appendLedger(dataDir, { ...base, id: "c", status: "failed", amountBaseUnits: "900000" });
    expect(spentLast24h(dataDir, USDC)).toBe(1_800_000n);
    expect(() => checkPayment(requirement("200001"), { maxAmount: "1" }, policy, network, dataDir)).toThrow(/24h limit/);
    // Exactly reaching the limit is allowed.
    expect(() => checkPayment(requirement("200000"), { maxAmount: "1" }, policy, network, dataDir)).not.toThrow();
  });

  test("ignores spend older than 24h", () => {
    const base = { url: "u", network: "aztec:testnet", asset: USDC.address, token: "USDC", amount: "", payTo: MERCHANT };
    appendLedger(dataDir, { ...base, id: "old", status: "paid", amountBaseUnits: "1900000" });
    const tomorrow = Date.now() + 25 * 60 * 60 * 1000;
    expect(spentLast24h(dataDir, USDC, tomorrow)).toBe(0n);
  });
});

describe("ledger", () => {
  test("later lines for the same id supersede earlier ones", () => {
    appendLedger(dataDir, { id: "x", status: "pending", amountBaseUnits: "1" });
    appendLedger(dataDir, { id: "x", status: "paid", txHash: "0xabc" });
    const [entry] = readLedger(dataDir);
    expect(entry.status).toBe("paid");
    expect(entry.txHash).toBe("0xabc");
    expect(entry.amountBaseUnits).toBe("1");
  });
});

describe("parseAmount", () => {
  test("parses decimal amounts into base units", () => {
    expect(parseAmount("0.05", USDC, "x")).toBe(50_000n);
    expect(parseAmount("2", USDC, "x")).toBe(2_000_000n);
  });

  test("rejects malformed amounts and excess precision", () => {
    expect(() => parseAmount("$1", USDC, "x")).toThrow(UsageError);
    expect(() => parseAmount("-1", USDC, "x")).toThrow(UsageError);
    expect(() => parseAmount("0.0000001", USDC, "x")).toThrow(/decimals/);
  });
});
