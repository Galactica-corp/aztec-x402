import { describe, it, expect, jest, beforeEach } from "bun:test";
import { createPaymentMiddleware } from "../middleware.js";
import type { MiddlewareConfig, MiddlewareResponse, RouteConfig } from "../types.js";

const TOKEN_ADDRESS = "0x" + "dd".repeat(32);
const SERVER_ADDRESS = "0x" + "bb".repeat(32);
const SENDER_ADDRESS = "0x" + "aa".repeat(32);
const TX_HASH = "0x" + "cc".repeat(32);

function createMockConfig(
  overrides?: Partial<MiddlewareConfig>,
): MiddlewareConfig {
  return {
    facilitator: {
      scheme: "exact",
      caipFamily: "aztec:*",
      getExtra: jest.fn().mockReturnValue(undefined),
      getSigners: jest.fn().mockReturnValue([SERVER_ADDRESS]),
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

describe("createPaymentMiddleware", () => {
  let config: MiddlewareConfig;

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

  it("returns 402 with PAYMENT-REQUIRED header when no payment provided", async () => {
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
  });

  it("verifies and settles when PAYMENT-SIGNATURE is provided", async () => {
    const routeConfig = createRouteConfig();
    const middleware = createPaymentMiddleware({ "/api/data": routeConfig }, config);

    const paymentPayload = {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "aztec:sandbox",
        asset: TOKEN_ADDRESS,
        amount: "100000",
        payTo: SERVER_ADDRESS,
        maxTimeoutSeconds: 120,
        extra: {},
      },
      payload: {
        senderAddress: SENDER_ADDRESS,
        correlationId: "test-id",
        txHash: TX_HASH,
        timestamp: new Date().toISOString(),
      },
    };

    const encodedPayment = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const req = createMockReq("/api/data", { "payment-signature": encodedPayment });
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

    const paymentPayload = {
      x402Version: 2,
      accepted: createRouteConfig(),
      payload: {
        senderAddress: SENDER_ADDRESS,
        correlationId: "test-id",
        txHash: TX_HASH,
        timestamp: new Date().toISOString(),
      },
    };

    const encodedPayment = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const req = createMockReq("/api/data", { "payment-signature": encodedPayment });
    const res = createMockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(402);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 500 when settlement fails", async () => {
    config.facilitator.settle = jest.fn().mockResolvedValue({
      success: false,
      errorReason: "settlement error",
    });

    const middleware = createPaymentMiddleware({ "/api/data": createRouteConfig() }, config);

    const paymentPayload = {
      x402Version: 2,
      accepted: createRouteConfig(),
      payload: {
        senderAddress: SENDER_ADDRESS,
        correlationId: "test-id",
        txHash: TX_HASH,
        timestamp: new Date().toISOString(),
      },
    };

    const encodedPayment = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const req = createMockReq("/api/data", { "payment-signature": encodedPayment });
    const res = createMockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(500);
    expect(next).not.toHaveBeenCalled();
  });

  it("sets PAYMENT-RESPONSE header after successful settlement", async () => {
    const middleware = createPaymentMiddleware({ "/api/data": createRouteConfig() }, config);

    const paymentPayload = {
      x402Version: 2,
      accepted: createRouteConfig(),
      payload: {
        senderAddress: SENDER_ADDRESS,
        correlationId: "test-id",
        txHash: TX_HASH,
        timestamp: new Date().toISOString(),
      },
    };

    const encodedPayment = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const req = createMockReq("/api/data", { "payment-signature": encodedPayment });
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
});
