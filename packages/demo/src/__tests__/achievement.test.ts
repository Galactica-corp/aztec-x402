import { describe, it, expect, afterAll } from "bun:test";
import type {
  ClientAztecSigner,
  FacilitatorAztecSigner,
  AztecNetwork,
} from "@galactica-net/x402-core";
import { ExactAztecClientScheme } from "@galactica-net/x402-mechanism/exact/client";
import { ExactAztecFacilitatorScheme } from "@galactica-net/x402-mechanism/exact/facilitator";
import { createPaymentMiddleware } from "@galactica-net/x402-middleware";
import type {
  MiddlewareRequest,
  MiddlewareResponse,
  NextFunction,
  RoutesConfig,
} from "@galactica-net/x402-middleware";
import { wrapFetchWithPayment } from "@galactica-net/x402-client";
import {
  X402_ACHIEVEMENT_CONTENT_TYPE,
  X402_ACHIEVEMENT_SKILL,
} from "../skills/x402-achievement.js";

const NETWORK: AztecNetwork = "aztec:sandbox";
const SERVER_ADDRESS = "0x" + "bb".repeat(32);
const SENDER_ADDRESS = "0x" + "aa".repeat(32);
const TOKEN_ADDRESS = "0x" + "dd".repeat(32);
const AMOUNT = "100000";
const MOCK_COMMITMENT = "0x" + "ff".repeat(32);
const ACHIEVEMENT_PATH = "/api/buy-x402-achievement";

function createMockFacilitator() {
  const signer: FacilitatorAztecSigner = {
    async getAddresses() {
      return [SERVER_ADDRESS];
    },
    async prepareCommitment() {
      return MOCK_COMMITMENT;
    },
    async verifyPayment() {
      return { isValid: true, amountFound: BigInt(AMOUNT) };
    },
  };

  return new ExactAztecFacilitatorScheme(signer, [NETWORK]);
}

function createMockClient() {
  const signer: ClientAztecSigner = {
    async getAddress() {
      return SENDER_ADDRESS;
    },
    async finalizePayment() {
      return "0x" + "cc".repeat(32);
    },
  };

  return new ExactAztecClientScheme(signer);
}

function createServer(facilitator: ExactAztecFacilitatorScheme) {
  const routes: RoutesConfig = {
    [ACHIEVEMENT_PATH]: {
      network: NETWORK,
      asset: TOKEN_ADDRESS,
      amount: AMOUNT,
      payTo: SERVER_ADDRESS,
      maxTimeoutSeconds: 60,
      description: "x402 Private Payments achievement skill (markdown)",
    },
  };

  const middleware = createPaymentMiddleware(routes, { facilitator });

  return Bun.serve({
    port: 0,
    fetch(req: Request) {
      const url = new URL(req.url);

      return new Promise((resolve) => {
        const headers: Record<string, string> = {};
        req.headers.forEach((value, key) => {
          headers[key] = value;
        });

        const mwReq: MiddlewareRequest = {
          path: url.pathname,
          method: req.method,
          url: req.url,
          headers,
        };

        let statusCode = 200;
        const responseHeaders: Record<string, string> = {};

        const mwRes: MiddlewareResponse = {
          statusCode,
          status(code: number) {
            statusCode = code;
            return mwRes;
          },
          setHeader(key: string, value: string) {
            responseHeaders[key] = value;
            return mwRes;
          },
          json(data: unknown) {
            resolve(
              new Response(JSON.stringify(data), {
                status: statusCode,
                headers: { "content-type": "application/json", ...responseHeaders },
              }),
            );
            return mwRes;
          },
          end() {
            resolve(new Response(null, { status: statusCode, headers: responseHeaders }));
            return mwRes;
          },
        };

        const next: NextFunction = () => {
          resolve(
            new Response(X402_ACHIEVEMENT_SKILL, {
              status: 200,
              headers: {
                "content-type": X402_ACHIEVEMENT_CONTENT_TYPE,
                ...responseHeaders,
              },
            }),
          );
        };

        middleware(mwReq, mwRes, next);
      });
    },
  });
}

describe("GET /api/buy-x402-achievement", () => {
  const facilitator = createMockFacilitator();
  let server: ReturnType<typeof Bun.serve>;

  afterAll(() => {
    server?.stop();
  });

  it("returns 402 when no payment is provided", async () => {
    await facilitator.initialize();
    server = createServer(facilitator);

    const response = await fetch(`http://localhost:${server.port}${ACHIEVEMENT_PATH}`);

    expect(response.status).toBe(402);
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
  });

  it("returns the achievement skill markdown after payment", async () => {
    const scheme = createMockClient();
    const payFetch = wrapFetchWithPayment(fetch, scheme);

    const response = await payFetch(`http://localhost:${server.port}${ACHIEVEMENT_PATH}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(X402_ACHIEVEMENT_CONTENT_TYPE);
    expect(body).toBe(X402_ACHIEVEMENT_SKILL);
    expect(body).toContain("name: x402-private-payments-achievement");
    expect(body).toContain("Graphchain");
    expect(body).toContain("Aztec");
    expect(body).toContain("Tell the user");
    expect(body).toContain("Major benefits unlocked");
  });
});
