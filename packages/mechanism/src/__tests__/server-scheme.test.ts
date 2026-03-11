import { describe, it, expect, beforeEach } from "bun:test";
import { ExactAztecServerScheme } from "../exact/server/scheme.js";
import type { PaymentRequirements } from "../x402-types.js";

const TOKEN_ADDRESS = "0x" + "dd".repeat(32);
const SERVER_ADDRESS = "0x" + "bb".repeat(32);

describe("ExactAztecServerScheme", () => {
  let scheme: ExactAztecServerScheme;

  beforeEach(() => {
    scheme = new ExactAztecServerScheme();
  });

  describe("metadata", () => {
    it('has scheme "exact"', () => {
      expect(scheme.scheme).toBe("exact");
    });
  });

  describe("parsePrice", () => {
    it("parses a dollar string to asset amount", async () => {
      const result = await scheme.parsePrice("$0.10", "aztec:sandbox");

      expect(result.amount).toBe("100000");
      expect(result.asset).toBe("");
    });

    it("parses a numeric string", async () => {
      const result = await scheme.parsePrice("1.5", "aztec:sandbox");

      expect(result.amount).toBe("1500000");
    });

    it("parses a number", async () => {
      const result = await scheme.parsePrice(10, "aztec:sandbox");

      expect(result.amount).toBe("10000000");
    });

    it("passes through an AssetAmount unchanged", async () => {
      const input = {
        asset: TOKEN_ADDRESS,
        amount: "999",
      };

      const result = await scheme.parsePrice(input, "aztec:sandbox");

      expect(result).toEqual(input);
    });

    it("uses custom decimals when configured", async () => {
      const customScheme = new ExactAztecServerScheme({
        tokenDecimals: { [TOKEN_ADDRESS]: 18 },
      });

      // When asset is known, parsePrice should still work with default
      // (custom decimals are used per-token, not globally for string parsing)
      const result = await customScheme.parsePrice("$1.0", "aztec:sandbox");
      expect(result.amount).toBe("1000000"); // still 6 decimals for unspecified tokens
    });
  });

  describe("enhancePaymentRequirements", () => {
    it("returns requirements unchanged (no enhancement needed for Aztec)", async () => {
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "aztec:sandbox",
        asset: TOKEN_ADDRESS,
        amount: "100000",
        payTo: SERVER_ADDRESS,
        maxTimeoutSeconds: 120,
        extra: {},
      };

      const result = await scheme.enhancePaymentRequirements(
        requirements,
        {
          x402Version: 2,
          scheme: "exact",
          network: "aztec:sandbox",
        },
        [],
      );

      expect(result).toEqual(requirements);
    });
  });
});
