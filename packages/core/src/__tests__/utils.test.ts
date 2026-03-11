import { describe, it, expect } from "bun:test";
import {
  generateCorrelationId,
  parsePrice,
  formatAmount,
  isValidAztecAddress,
  isAztecNetwork,
} from "../utils.js";

describe("generateCorrelationId", () => {
  it("returns a non-empty string", () => {
    const id = generateCorrelationId();
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  });

  it("returns unique values on successive calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateCorrelationId()));
    expect(ids.size).toBe(100);
  });
});

describe("parsePrice", () => {
  it("parses a dollar-prefixed string", () => {
    expect(parsePrice("$0.10")).toBe(100_000n);
  });

  it("parses a plain numeric string", () => {
    expect(parsePrice("1.5")).toBe(1_500_000n);
  });

  it("parses an integer string", () => {
    expect(parsePrice("10")).toBe(10_000_000n);
  });

  it("parses a number value", () => {
    expect(parsePrice(0.01)).toBe(10_000n);
  });

  it("handles zero", () => {
    expect(parsePrice("0")).toBe(0n);
    expect(parsePrice(0)).toBe(0n);
  });

  it("respects custom decimals", () => {
    // 18 decimals (like ETH)
    expect(parsePrice("1.0", 18)).toBe(1_000_000_000_000_000_000n);
  });

  it("truncates excess decimal places", () => {
    // "$0.123456789" with 6 decimals should become 123456
    expect(parsePrice("$0.123456789")).toBe(123_456n);
  });

  it("pads short decimal places", () => {
    expect(parsePrice("$0.1")).toBe(100_000n);
  });

  it("throws on negative values", () => {
    expect(() => parsePrice("-1")).toThrow("Invalid price");
  });

  it("throws on non-numeric strings", () => {
    expect(() => parsePrice("abc")).toThrow("Invalid price");
  });
});

describe("formatAmount", () => {
  it("formats a standard amount", () => {
    expect(formatAmount(100_000n)).toBe("0.100000");
  });

  it("formats a whole number amount", () => {
    expect(formatAmount(10_000_000n)).toBe("10.000000");
  });

  it("formats zero", () => {
    expect(formatAmount(0n)).toBe("0.000000");
  });

  it("formats with custom decimals", () => {
    expect(formatAmount(1_000_000_000_000_000_000n, 18)).toBe(
      "1.000000000000000000",
    );
  });

  it("round-trips with parsePrice", () => {
    const original = "$123.456789";
    const parsed = parsePrice(original);
    const formatted = formatAmount(parsed);
    expect(formatted).toBe("123.456789");
  });
});

describe("isValidAztecAddress", () => {
  it("accepts a valid 32-byte hex address", () => {
    const addr = "0x" + "a".repeat(64);
    expect(isValidAztecAddress(addr)).toBe(true);
  });

  it("accepts mixed case hex", () => {
    const addr = "0x" + "aAbBcCdDeEfF".repeat(5) + "aAbB";
    expect(isValidAztecAddress(addr)).toBe(true);
  });

  it("rejects address without 0x prefix", () => {
    const addr = "a".repeat(64);
    expect(isValidAztecAddress(addr)).toBe(false);
  });

  it("rejects address that is too short", () => {
    const addr = "0x" + "a".repeat(63);
    expect(isValidAztecAddress(addr)).toBe(false);
  });

  it("rejects address that is too long", () => {
    const addr = "0x" + "a".repeat(65);
    expect(isValidAztecAddress(addr)).toBe(false);
  });

  it("rejects address with invalid hex chars", () => {
    const addr = "0x" + "g".repeat(64);
    expect(isValidAztecAddress(addr)).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidAztecAddress("")).toBe(false);
  });
});

describe("isAztecNetwork", () => {
  it("accepts aztec:sandbox", () => {
    expect(isAztecNetwork("aztec:sandbox")).toBe(true);
  });

  it("accepts aztec:devnet", () => {
    expect(isAztecNetwork("aztec:devnet")).toBe(true);
  });

  it("accepts aztec:1", () => {
    expect(isAztecNetwork("aztec:1")).toBe(true);
  });

  it("rejects eip155:8453", () => {
    expect(isAztecNetwork("eip155:8453")).toBe(false);
  });

  it("rejects solana:mainnet", () => {
    expect(isAztecNetwork("solana:mainnet")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isAztecNetwork("")).toBe(false);
  });

  it("rejects plain 'aztec' without colon", () => {
    expect(isAztecNetwork("aztec")).toBe(false);
  });
});
