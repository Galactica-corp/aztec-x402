import { describe, it, expect, jest, beforeEach } from "bun:test";
import { wrapFetchWithPayment } from "../client.js";
import type { SchemeNetworkClient, PaymentRequirements } from "@aztec-x402/mechanism";

const SENDER_ADDRESS = "0x" + "aa".repeat(32);
const SERVER_ADDRESS = "0x" + "bb".repeat(32);
const TOKEN_ADDRESS = "0x" + "dd".repeat(32);
const TX_HASH = "0x" + "cc".repeat(32);
const MOCK_COMMITMENT = "0x" + "ff".repeat(32);
const MOCK_NONCE = "01234567-0123-0123-0123-012345678901";

function createMockScheme(): SchemeNetworkClient & { signer: { getAddress: ReturnType<typeof jest.fn> } } {
  return {
    scheme: "exact",
    signer: {
      getAddress: jest.fn().mockResolvedValue(SENDER_ADDRESS),
    },
    createPaymentPayload: jest.fn().mockResolvedValue({
      x402Version: 2,
      payload: {
        senderAddress: SENDER_ADDRESS,
        correlationId: "test-id",
        txHash: TX_HASH,
        timestamp: new Date().toISOString(),
      },
    }),
  };
}

function createPaymentRequired(extra: Record<string, unknown> = {}) {
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: "aztec:sandbox",
    asset: TOKEN_ADDRESS,
    amount: "100000",
    payTo: SERVER_ADDRESS,
    maxTimeoutSeconds: 120,
    extra,
  };

  return {
    x402Version: 2,
    accepts: [requirements],
  };
}

function encode402(extra: Record<string, unknown> = {}): string {
  return Buffer.from(JSON.stringify(createPaymentRequired(extra))).toString("base64");
}

describe("wrapFetchWithPayment", () => {
  let scheme: ReturnType<typeof createMockScheme>;

  beforeEach(() => {
    scheme = createMockScheme();
  });

  it("passes through non-402 responses unchanged", async () => {
    const mockFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: "hello" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const wrappedFetch = wrapFetchWithPayment(mockFetch, scheme);
    const response = await wrappedFetch("https://api.example.com/data");

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(scheme.createPaymentPayload).not.toHaveBeenCalled();
  });

  it("returns 402 if no PAYMENT-REQUIRED header present", async () => {
    const mockFetch = jest.fn().mockResolvedValue(
      new Response("Payment Required", { status: 402 }),
    );

    const wrappedFetch = wrapFetchWithPayment(mockFetch, scheme);
    const response = await wrappedFetch("https://api.example.com/data");

    expect(response.status).toBe(402);
    expect(scheme.createPaymentPayload).not.toHaveBeenCalled();
  });

  it("handles full 3-request flow: initial → prepare → payment", async () => {
    const mockFetch = jest
      .fn()
      // Phase 1: initial request → 402 with nonce
      .mockResolvedValueOnce(
        new Response("Payment Required", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": encode402({ nonce: MOCK_NONCE }) },
        }),
      )
      // Phase 2: prepare request → 402 with nonce + commitment
      .mockResolvedValueOnce(
        new Response("Payment Required", {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": encode402({
              nonce: MOCK_NONCE,
              commitment: MOCK_COMMITMENT,
            }),
          },
        }),
      )
      // Phase 3: payment request → success
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: "paid content" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const wrappedFetch = wrapFetchWithPayment(mockFetch, scheme);
    const response = await wrappedFetch("https://api.example.com/data");

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Phase 2 should include X-402-PREPARE header
    const prepareCall = mockFetch.mock.calls[1];
    const prepareInit: Record<string, unknown> = prepareCall[1];
    const prepareHeaders: Record<string, string> = prepareInit.headers;
    expect(prepareHeaders["X-402-PREPARE"]).toBeTruthy();

    // Decode and verify prepare data contains nonce + sender address
    const prepareData = JSON.parse(
      Buffer.from(prepareHeaders["X-402-PREPARE"], "base64").toString(),
    );
    expect(prepareData.nonce).toBe(MOCK_NONCE);
    expect(prepareData.senderAddress).toBe(SENDER_ADDRESS);

    // Phase 3 should include PAYMENT-SIGNATURE header
    const paymentCall = mockFetch.mock.calls[2];
    const paymentInit: Record<string, unknown> = paymentCall[1];
    const paymentHeaders: Record<string, string> = paymentInit.headers;
    expect(paymentHeaders["PAYMENT-SIGNATURE"]).toBeTruthy();

    // createPaymentPayload should receive requirements with commitment
    expect(scheme.createPaymentPayload).toHaveBeenCalledTimes(1);
    const payloadCall = (scheme.createPaymentPayload as ReturnType<typeof jest.fn>).mock.calls[0];
    const requirements = payloadCall[1] as PaymentRequirements;
    expect(requirements.extra?.commitment).toBe(MOCK_COMMITMENT);
  });

  it("passes through original request options on retry", async () => {
    const mockFetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response("Payment Required", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": encode402({ nonce: MOCK_NONCE }) },
        }),
      )
      .mockResolvedValueOnce(
        new Response("Payment Required", {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": encode402({
              nonce: MOCK_NONCE,
              commitment: MOCK_COMMITMENT,
            }),
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response("ok", { status: 200 }),
      );

    const wrappedFetch = wrapFetchWithPayment(mockFetch, scheme);
    await wrappedFetch("https://api.example.com/data", {
      method: "POST",
      headers: { "X-Custom": "value" },
      body: "test body",
    });

    // Phase 3 should preserve original headers + add PAYMENT-SIGNATURE
    const retryCall = mockFetch.mock.calls[2];
    expect(retryCall[0]).toBe("https://api.example.com/data");
    const retryInit: Record<string, unknown> = retryCall[1];
    expect(retryInit.method).toBe("POST");
    expect(retryInit.body).toBe("test body");
    const headers: Record<string, string> = retryInit.headers;
    expect(headers["X-Custom"]).toBe("value");
    expect(headers["PAYMENT-SIGNATURE"]).toBeTruthy();
  });

  it("falls back gracefully when prepare phase returns non-402", async () => {
    const mockFetch = jest
      .fn()
      // Phase 1: initial 402 with nonce
      .mockResolvedValueOnce(
        new Response("Payment Required", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": encode402({ nonce: MOCK_NONCE }) },
        }),
      )
      // Phase 2: prepare returns 500 (server error)
      .mockResolvedValueOnce(
        new Response("Internal Server Error", { status: 500 }),
      )
      // Phase 3: payment still attempted with original requirements
      .mockResolvedValueOnce(
        new Response("ok", { status: 200 }),
      );

    const wrappedFetch = wrapFetchWithPayment(mockFetch, scheme);
    const response = await wrappedFetch("https://api.example.com/data");

    // Should still attempt payment with original requirements
    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
