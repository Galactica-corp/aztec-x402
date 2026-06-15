import { describe, it, expect, jest, beforeEach } from "bun:test";
import { createPaymentMiddleware } from "../middleware.js";
import type { MiddlewareConfig, MiddlewareResponse, RouteConfig } from "../types.js";
import { PaymentRequirementsSchema } from "@galactica-net/x402-mechanism";
import { parseAztecPaymentExtra } from "@galactica-net/x402-core";
import { z } from "zod";

const TOKEN_ADDRESS = "0x" + "dd".repeat(32);
const SERVER_ADDRESS = "0x" + "bb".repeat(32);
const SENDER_ADDRESS = "0x" + "aa".repeat(32);
const TX_HASH = "0x" + "cc".repeat(32);
const MOCK_COMMITMENT = "0x" + "ff".repeat(32);

type MockFn = ReturnType<typeof jest.fn>;
type MiddlewareFacilitator = MiddlewareConfig["facilitator"];

interface MockFacilitator extends MiddlewareFacilitator {
  getExtra: MockFn;
  getSigners: MockFn;
  preparePayment: MockFn;
  verify: MockFn;
  settle: MockFn;
}

interface MockMiddlewareConfig extends MiddlewareConfig {
  facilitator: MockFacilitator;
}

const ErrorBodySchema = z
  .object({
    error: z.string().optional(),
  })
  .passthrough();

function parseError(body: unknown): string | undefined {
  return ErrorBodySchema.parse(body).error;
}

function createMockConfig(
  overrides?: Partial<MockMiddlewareConfig>,
): MockMiddlewareConfig {
  return {
    facilitator: {
      scheme: "exact",
      caipFamily: "aztec:*",
      getExtra: jest.fn().mockReturnValue(undefined),
      getSigners: jest.fn().mockReturnValue([SERVER_ADDRESS]),
      preparePayment: jest.fn().mockResolvedValue({ commitment: MOCK_COMMITMENT }),
      verify: jest.fn().mockResolvedValue({
        isValid: true,
        payer: SENDER_ADDRESS,
      }),
      settle: jest.fn().mockResolvedValue({
        success: true,
        payer: SENDER_ADDRESS,
        transaction: TX_HASH,
        network: "aztec:sandbox",
      }),
    },
    ...overrides,
  };
}

function createRouteConfig(): RouteConfig {
  return {
    network: "aztec:sandbox",
    asset: TOKEN_ADDRESS,
    amount: "100000",
    payTo: SERVER_ADDRESS,
    maxTimeoutSeconds: 120,
  };
}

// Minimal request/response mocks
function createMockReq(
  path: string,
  headers: Record<string, string> = {},
) {
  return {
    path,
    method: "GET",
    headers: { ...headers },
    url: path,
  };
}

interface MockRes extends MiddlewareResponse {
  headers: Record<string, string>;
  body: unknown;
}

function createMockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(key: string, value: string) {
      res.headers[key] = value;
      return res;
    },
    json(data: unknown) {
      res.body = data;
      return res;
    },
    end() {
      return res;
    },
  };
  return res;
}

/** Helper: send a request without payment to get a 402 and extract the nonce */
async function getNonce(
  middleware: ReturnType<typeof createPaymentMiddleware>,
  path: string,
): Promise<string> {
  const req = createMockReq(path);
  const res = createMockRes();
  await middleware(req, res, jest.fn());
  const decoded = JSON.parse(
    Buffer.from(res.headers["PAYMENT-REQUIRED"], "base64").toString(),
  );
  return decoded.accepts[0].extra.nonce;
}

/** Helper: send X-402-PREPARE with nonce+address to get commitment */
async function prepareCommitment(
  middleware: ReturnType<typeof createPaymentMiddleware>,
  path: string,
  nonce: string,
  senderAddress: string = SENDER_ADDRESS,
): Promise<string | undefined> {
  const prepareData = Buffer.from(
    JSON.stringify({ nonce, senderAddress }),
  ).toString("base64");
  const req = createMockReq(path, { "x-402-prepare": prepareData });
  const res = createMockRes();
  await middleware(req, res, jest.fn());
  const decoded = JSON.parse(
    Buffer.from(res.headers["PAYMENT-REQUIRED"], "base64").toString(),
  );
  return decoded.accepts[0].extra?.commitment;
}

/** Helper: build a payment payload with the given nonce */
function buildPaymentPayload(nonce?: string) {
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "aztec:sandbox",
      asset: TOKEN_ADDRESS,
      amount: "100000",
      payTo: SERVER_ADDRESS,
      maxTimeoutSeconds: 120,
      extra: nonce != null ? { nonce } : {},
    },
    payload: {
      senderAddress: SENDER_ADDRESS,
      correlationId: "test-id",
      txHash: TX_HASH,
      timestamp: new Date().toISOString(),
    },
  };
}

function encodePayload(payload: object): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

describe("createPaymentMiddleware", () => {
  let config: MockMiddlewareConfig;

  beforeEach(() => {
    config = createMockConfig();
  });

  it("returns a function", () => {
    const middleware = createPaymentMiddleware({ "/api/data": createRouteConfig() }, config);
    expect(typeof middleware).toBe("function");
  });

  it("passes through requests to non-gated routes", async () => {
    const middleware = createPaymentMiddleware({ "/api/data": createRouteConfig() }, config);
    const req = createMockReq("/api/other");
    const res = createMockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it("returns 402 with PAYMENT-REQUIRED header and nonce when no payment provided", async () => {
    const routeConfig = createRouteConfig();
    const middleware = createPaymentMiddleware({ "/api/data": routeConfig }, config);
    const req = createMockReq("/api/data");
    const res = createMockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(402);
    expect(res.headers["PAYMENT-REQUIRED"]).toBeTruthy();
    expect(next).not.toHaveBeenCalled();

    // Decode the PAYMENT-REQUIRED header
    const decoded = JSON.parse(
      Buffer.from(res.headers["PAYMENT-REQUIRED"], "base64").toString(),
    );
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts).toBeInstanceOf(Array);
    expect(decoded.accepts[0].scheme).toBe("exact");
    expect(decoded.accepts[0].network).toBe("aztec:sandbox");
    expect(decoded.accepts[0].amount).toBe("100000");
    // Nonce should be present and be a UUID string
    expect(decoded.accepts[0].extra.nonce).toBeTruthy();
    expect(typeof decoded.accepts[0].extra.nonce).toBe("string");
    expect(decoded.accepts[0].extra.nonce.length).toBe(36);
  });

  it("verifies and settles when valid nonce is provided", async () => {
    const routeConfig = createRouteConfig();
    const middleware = createPaymentMiddleware({ "/api/data": routeConfig }, config);

    // Step 1: Get nonce from 402 response
    const nonce = await getNonce(middleware, "/api/data");

    // Step 2: Send payment with that nonce
    const paymentPayload = buildPaymentPayload(nonce);
    const req = createMockReq("/api/data", {
      "payment-signature": encodePayload(paymentPayload),
    });
    const res = createMockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(config.facilitator.verify).toHaveBeenCalled();
    expect(config.facilitator.settle).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it("returns 402 when verification fails", async () => {
    config.facilitator.verify = jest.fn().mockResolvedValue({
      isValid: false,
      invalidReason: "insufficient payment",
    });

    const middleware = createPaymentMiddleware({ "/api/data": createRouteConfig() }, config);

    const nonce = await getNonce(middleware, "/api/data");
    const paymentPayload = buildPaymentPayload(nonce);
    const req = createMockReq("/api/data", {
      "payment-signature": encodePayload(paymentPayload),
    });
    const res = createMockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(402);
    expect(next).not.toHaveBeenCalled();
  });

  it("allows retry with the same nonce after retryable verification failure", async () => {
    config.facilitator.verify = jest.fn()
      .mockResolvedValueOnce({
        isValid: false,
        invalidReason: "completion log lookup failed: PXE timeout",
      })
      .mockResolvedValueOnce({
        isValid: true,
        payer: SENDER_ADDRESS,
      });

    const middleware = createPaymentMiddleware({ "/api/data": createRouteConfig() }, config);

    const nonce = await getNonce(middleware, "/api/data");
    await prepareCommitment(middleware, "/api/data", nonce);
    const paymentPayload = buildPaymentPayload(nonce);

    const firstReq = createMockReq("/api/data", {
      "payment-signature": encodePayload(paymentPayload),
    });
    const firstRes = createMockRes();
    await middleware(firstReq, firstRes, jest.fn());

    expect(firstRes.statusCode).toBe(402);

    const retryReq = createMockReq("/api/data", {
      "payment-signature": encodePayload(paymentPayload),
    });
    const retryRes = createMockRes();
    const retryNext = jest.fn();
    await middleware(retryReq, retryRes, retryNext);

    expect(config.facilitator.verify).toHaveBeenCalledTimes(2);
    expect(config.facilitator.settle).toHaveBeenCalledTimes(1);
    expect(retryNext).toHaveBeenCalled();
  });

  it("returns 500 when settlement fails", async () => {
    config.facilitator.settle = jest.fn().mockResolvedValue({
      success: false,
      errorReason: "settlement error",
    });

    const middleware = createPaymentMiddleware({ "/api/data": createRouteConfig() }, config);

    const nonce = await getNonce(middleware, "/api/data");
    const paymentPayload = buildPaymentPayload(nonce);
    const req = createMockReq("/api/data", {
      "payment-signature": encodePayload(paymentPayload),
    });
    const res = createMockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(500);
    expect(next).not.toHaveBeenCalled();
  });

  it("sets PAYMENT-RESPONSE header after successful settlement", async () => {
    const middleware = createPaymentMiddleware({ "/api/data": createRouteConfig() }, config);

    const nonce = await getNonce(middleware, "/api/data");
    const paymentPayload = buildPaymentPayload(nonce);
    const req = createMockReq("/api/data", {
      "payment-signature": encodePayload(paymentPayload),
    });
    const res = createMockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.headers["PAYMENT-RESPONSE"]).toBeTruthy();
    const decoded = JSON.parse(
      Buffer.from(res.headers["PAYMENT-RESPONSE"], "base64").toString(),
    );
    expect(decoded.success).toBe(true);
    expect(decoded.transaction).toBe(TX_HASH);
  });

  // Nonce-specific tests

  it("rejects payment with missing nonce", async () => {
    const middleware = createPaymentMiddleware({ "/api/data": createRouteConfig() }, config);

    const paymentPayload = buildPaymentPayload(); // no nonce
    const req = createMockReq("/api/data", {
      "payment-signature": encodePayload(paymentPayload),
    });
    const res = createMockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(402);
    expect(next).not.toHaveBeenCalled();
    expect(parseError(res.body)).toBe("missing payment nonce");
  });

  it("rejects payment with fabricated nonce", async () => {
    const middleware = createPaymentMiddleware({ "/api/data": createRouteConfig() }, config);

    const paymentPayload = buildPaymentPayload("00000000-0000-0000-0000-000000000000");
    const req = createMockReq("/api/data", {
      "payment-signature": encodePayload(paymentPayload),
    });
    const res = createMockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(402);
    expect(next).not.toHaveBeenCalled();
    expect(parseError(res.body)).toBe("invalid or expired payment nonce");
  });

  it("rejects replay of consumed nonce", async () => {
    // Use two routes so we can test nonce replay on an unpaid resource
    const middleware = createPaymentMiddleware({
      "/api/r1": createRouteConfig(),
      "/api/r2": createRouteConfig(),
    }, config);

    // Get nonce and use it on /api/r1
    const nonce = await getNonce(middleware, "/api/r1");
    const paymentPayload = buildPaymentPayload(nonce);

    const req1 = createMockReq("/api/r1", {
      "payment-signature": encodePayload(paymentPayload),
    });
    const res1 = createMockRes();
    await middleware(req1, res1, jest.fn());
    expect(res1.statusCode).not.toBe(402);

    // Replay same consumed nonce on a different unpaid resource
    const req2 = createMockReq("/api/r2", {
      "payment-signature": encodePayload(paymentPayload),
    });
    const res2 = createMockRes();
    const next2 = jest.fn();
    await middleware(req2, res2, next2);

    expect(res2.statusCode).toBe(402);
    expect(next2).not.toHaveBeenCalled();
    expect(parseError(res2.body)).toBe("invalid or expired payment nonce");
  });

  it("rejects expired nonce", async () => {
    const routeConfig = createRouteConfig();
    routeConfig.maxTimeoutSeconds = 1; // 1 second timeout
    const middleware = createPaymentMiddleware({ "/api/data": routeConfig }, config);

    // Get nonce
    const nonce = await getNonce(middleware, "/api/data");

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const paymentPayload = buildPaymentPayload(nonce);
    const req = createMockReq("/api/data", {
      "payment-signature": encodePayload(paymentPayload),
    });
    const res = createMockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(402);
    expect(next).not.toHaveBeenCalled();
    expect(parseError(res.body)).toBe("invalid or expired payment nonce");
  });

  it("generates unique nonces per 402 response", async () => {
    const middleware = createPaymentMiddleware({ "/api/data": createRouteConfig() }, config);

    const nonce1 = await getNonce(middleware, "/api/data");
    const nonce2 = await getNonce(middleware, "/api/data");

    expect(nonce1).not.toBe(nonce2);
  });

  // Prepare phase (X-402-PREPARE) tests

  it("returns 402 with commitment after prepare phase", async () => {
    const middleware = createPaymentMiddleware({ "/api/data": createRouteConfig() }, config);

    const nonce = await getNonce(middleware, "/api/data");
    const commitment = await prepareCommitment(middleware, "/api/data", nonce);

    expect(commitment).toBe(MOCK_COMMITMENT);
    const prepareCall = config.facilitator.preparePayment.mock.calls[0];
    expect(prepareCall[0]).toBe(TOKEN_ADDRESS);
    expect(prepareCall[1]).toBe(SENDER_ADDRESS);
    expect(prepareCall[2].nonce).toBe(nonce);
    expect(prepareCall[2].timeoutMs).toBe(120_000);
  });

  it("rejects prepare with invalid nonce", async () => {
    const middleware = createPaymentMiddleware({ "/api/data": createRouteConfig() }, config);

    const prepareData = Buffer.from(
      JSON.stringify({ nonce: "00000000-0000-0000-0000-000000000000", senderAddress: SENDER_ADDRESS }),
    ).toString("base64");
    const req = createMockReq("/api/data", { "x-402-prepare": prepareData });
    const res = createMockRes();
    await middleware(req, res, jest.fn());

    expect(res.statusCode).toBe(402);
    const decoded = JSON.parse(
      Buffer.from(res.headers["PAYMENT-REQUIRED"], "base64").toString(),
    );
    expect(decoded.error).toBe("invalid or expired payment nonce");
  });

  it("rejects prepare with missing senderAddress", async () => {
    const middleware = createPaymentMiddleware({ "/api/data": createRouteConfig() }, config);

    const nonce = await getNonce(middleware, "/api/data");
    const prepareData = Buffer.from(
      JSON.stringify({ nonce }),
    ).toString("base64");
    const req = createMockReq("/api/data", { "x-402-prepare": prepareData });
    const res = createMockRes();
    await middleware(req, res, jest.fn());

    expect(res.statusCode).toBe(402);
    const decoded = JSON.parse(
      Buffer.from(res.headers["PAYMENT-REQUIRED"], "base64").toString(),
    );
    expect(decoded.error).toContain("senderAddress");
  });

  it("does not create a second commitment for the same nonce and sender", async () => {
    const middleware = createPaymentMiddleware({ "/api/data": createRouteConfig() }, config);

    const nonce = await getNonce(middleware, "/api/data");
    const first = await prepareCommitment(middleware, "/api/data", nonce);
    const second = await prepareCommitment(middleware, "/api/data", nonce);

    expect(first).toBe(MOCK_COMMITMENT);
    expect(second).toBe(MOCK_COMMITMENT);
    expect(config.facilitator.preparePayment).toHaveBeenCalledTimes(1);
  });

  it("rejects prepare sender changes for an existing nonce", async () => {
    const middleware = createPaymentMiddleware({ "/api/data": createRouteConfig() }, config);

    const nonce = await getNonce(middleware, "/api/data");
    await prepareCommitment(middleware, "/api/data", nonce);

    const prepareData = Buffer.from(
      JSON.stringify({ nonce, senderAddress: "0x" + "ab".repeat(32) }),
    ).toString("base64");
    const req = createMockReq("/api/data", { "x-402-prepare": prepareData });
    const res = createMockRes();
    await middleware(req, res, jest.fn());

    const decoded = JSON.parse(
      Buffer.from(res.headers["PAYMENT-REQUIRED"], "base64").toString(),
    );
    expect(res.statusCode).toBe(402);
    expect(decoded.error).toContain("senderAddress");
    expect(config.facilitator.preparePayment).toHaveBeenCalledTimes(1);
  });

  it("carries commitment through to payment phase after prepare", async () => {
    const middleware = createPaymentMiddleware({ "/api/data": createRouteConfig() }, config);

    // Phase 1: get nonce
    const nonce = await getNonce(middleware, "/api/data");

    // Phase 2: prepare — get commitment
    await prepareCommitment(middleware, "/api/data", nonce);

    // Phase 3: pay with nonce
    const paymentPayload = buildPaymentPayload(nonce);
    const req = createMockReq("/api/data", {
      "payment-signature": encodePayload(paymentPayload),
    });
    const res = createMockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    // Verify that the facilitator.verify was called with requirements containing commitment
    const verifyCall = config.facilitator.verify.mock.calls[0];
    const verifyRequirements = PaymentRequirementsSchema.parse(verifyCall[1]);
    expect(parseAztecPaymentExtra(verifyRequirements.extra).commitment).toBe(MOCK_COMMITMENT);
  });
});
