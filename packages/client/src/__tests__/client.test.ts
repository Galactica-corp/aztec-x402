import { describe, it, expect, jest, beforeEach } from "bun:test";
import { wrapFetchWithPayment } from "../client.js";
import type { SchemeNetworkClient, PaymentRequirements } from "@aztech-x402/mechanism";

const SENDER_ADDRESS = "0x" + "aa".repeat(32);
const SERVER_ADDRESS = "0x" + "bb".repeat(32);
const TOKEN_ADDRESS = "0x" + "dd".repeat(32);
const TX_HASH = "0x" + "cc".repeat(32);

function createMockScheme(): SchemeNetworkClient {
  return {
    scheme: "exact",
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

function createPaymentRequired() {
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: "aztec:sandbox",
    asset: TOKEN_ADDRESS,
    amount: "100000",
    payTo: SERVER_ADDRESS,
    maxTimeoutSeconds: 120,
    extra: {},
  };

  return {
    x402Version: 2,
    accepts: [requirements],
  };
}

describe("wrapFetchWithPayment", () => {
  let scheme: SchemeNetworkClient;

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

  it("handles 402 by creating payment and retrying", async () => {
    const paymentRequired = createPaymentRequired();
    const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");

    const mockFetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response("Payment Required", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": encoded },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: "paid content" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const wrappedFetch = wrapFetchWithPayment(mockFetch, scheme);
    const response = await wrappedFetch("https://api.example.com/data");

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(scheme.createPaymentPayload).toHaveBeenCalledTimes(1);

    // Check that the retry includes the PAYMENT-SIGNATURE header
    const retryCall = mockFetch.mock.calls[1];
    const retryInit: Record<string, unknown> = retryCall[1];
    const headers: Record<string, string> = retryInit.headers;
    expect(headers["PAYMENT-SIGNATURE"]).toBeTruthy();
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

  it("passes through the original request options on retry", async () => {
    const paymentRequired = createPaymentRequired();
    const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");

    const mockFetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response("Payment Required", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": encoded },
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

    const retryCall = mockFetch.mock.calls[1];
    expect(retryCall[0]).toBe("https://api.example.com/data");
    const retryInit: Record<string, unknown> = retryCall[1];
    expect(retryInit.method).toBe("POST");
    expect(retryInit.body).toBe("test body");
    // Should merge custom headers with payment header
    const headers: Record<string, string> = retryInit.headers;
    expect(headers["X-Custom"]).toBe("value");
    expect(headers["PAYMENT-SIGNATURE"]).toBeTruthy();
  });

  it("does not retry more than once", async () => {
    const paymentRequired = createPaymentRequired();
    const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");

    const mockFetch = jest.fn().mockResolvedValue(
      new Response("Payment Required", {
        status: 402,
        headers: { "PAYMENT-REQUIRED": encoded },
      }),
    );

    const wrappedFetch = wrapFetchWithPayment(mockFetch, scheme);
    const response = await wrappedFetch("https://api.example.com/data");

    // First call + one retry = 2 calls total
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(402);
  });
});
