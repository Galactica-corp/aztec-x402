import { describe, expect, test } from "bun:test";
import { decodePaymentRequired, describeRequirement, selectRequirement, trimAmount } from "../x402.js";
import type { NetworkConfig } from "../networks.js";
import type { ParsedPaymentRequirements } from "@galactica-net/x402-mechanism";

const USDC = "0x2bb09ca02aeabb84fbe69537a0bf4b5ed57112466dc4666f9639157fe8dcfcf7";
const network: NetworkConfig = {
  name: "testnet",
  caip2: "aztec:testnet",
  nodeUrl: "http://node",
  proverEnabled: true,
  sponsoredFees: true,
  l1ChainId: 11155111,
  l1ChainName: "Sepolia",
  l1RpcUrl: "http://l1",
  tokens: [{ symbol: "USDC", name: "USDC", address: USDC, decimals: 6 }],
};

function challengeResponse(body: unknown): Response {
  const header = Buffer.from(JSON.stringify(body)).toString("base64");
  return new Response(JSON.stringify(body), { status: 402, headers: { "PAYMENT-REQUIRED": header } });
}

const requirement: ParsedPaymentRequirements = {
  scheme: "exact",
  network: "aztec:testnet",
  asset: USDC,
  amount: "10000",
  payTo: "0x0dd252a7d60fcad329acac8ec80314194ab0ec3c99323263b3417651153c056c",
  maxTimeoutSeconds: 600,
  extra: { nonce: "n-1" },
};

describe("decodePaymentRequired", () => {
  test("decodes the challenge with its description and error", () => {
    const decoded = decodePaymentRequired(
      challengeResponse({ x402Version: 2, error: "boom", resource: { description: "Weather" }, accepts: [requirement] }),
    );
    expect(decoded?.description).toBe("Weather");
    expect(decoded?.error).toBe("boom");
    expect(decoded?.accepts[0].amount).toBe("10000");
  });

  test("returns undefined without a header or with garbage", () => {
    expect(decodePaymentRequired(new Response("", { status: 402 }))).toBeUndefined();
    expect(
      decodePaymentRequired(new Response("", { status: 402, headers: { "PAYMENT-REQUIRED": "not-base64-json" } })),
    ).toBeUndefined();
  });
});

describe("selectRequirement / describeRequirement", () => {
  test("picks the exact scheme on the agent's network", () => {
    const other = { ...requirement, network: "eip155:8453" };
    const decoded = decodePaymentRequired(challengeResponse({ x402Version: 2, accepts: [other, requirement] }));
    expect(decoded && selectRequirement(decoded, network)?.network).toBe("aztec:testnet");
  });

  test("formats a payable requirement in human units", () => {
    const view = describeRequirement({ ...requirement }, network);
    expect(view).toMatchObject({ token: "USDC", amount: "0.01", payable: true });
  });

  test("explains why a requirement is not payable", () => {
    expect(describeRequirement({ ...requirement, network: "aztec:sandbox" }, network).reason).toMatch(/aztec:sandbox/);
    expect(describeRequirement({ ...requirement, asset: "0x" + "33".repeat(32) }, network).reason).toMatch(
      /unknown asset/,
    );
  });
});

test("trimAmount drops trailing zeros", () => {
  expect(trimAmount("0.010000")).toBe("0.01");
  expect(trimAmount("5.000000")).toBe("5");
  expect(trimAmount("12")).toBe("12");
});
