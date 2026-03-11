import { describe, it, expect, afterAll } from "bun:test";
import type {
  ClientAztecSigner,
  FacilitatorAztecSigner,
  AztecNetwork,
} from "@aztec-x402/core";
import { ExactAztecClientScheme } from "@aztec-x402/mechanism/exact/client";
import { ExactAztecFacilitatorScheme } from "@aztec-x402/mechanism/exact/facilitator";
import { createPaymentMiddleware } from "@aztec-x402/middleware";
import type {
  MiddlewareRequest,
  MiddlewareResponse,
  NextFunction,
  RoutesConfig,
} from "@aztec-x402/middleware";
import { wrapFetchWithPayment } from "@aztec-x402/client";

const NETWORK: AztecNetwork = "aztec:sandbox";
const SERVER_ADDRESS = "0x" + "bb".repeat(32);
const SENDER_ADDRESS = "0x" + "aa".repeat(32);
const TOKEN_ADDRESS = "0x" + "dd".repeat(32);
const AMOUNT = "100000";

function createMockFacilitator() {
  const signer: FacilitatorAztecSigner = {
    async getAddresses() {
      return [SERVER_ADDRESS];
    },
    async registerSender() {},
    async verifyPaymentNotes() {
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
    async transferPrivateToPrivate() {
      return "0x" + "ff".repeat(32);
    },
  };

  return new ExactAztecClientScheme(signer);
}

function createServer(facilitator: ExactAztecFacilitatorScheme) {
  const routes: RoutesConfig = {
    "/api/weather": {
      network: NETWORK,
      asset: TOKEN_ADDRESS,
      amount: AMOUNT,
      payTo: SERVER_ADDRESS,
      maxTimeoutSeconds: 60,
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
            new Response(JSON.stringify({ weather: "sunny", paid: true }), {
              status: 200,
              headers: { "content-type": "application/json", ...responseHeaders },
            }),
          );
        };

        middleware(mwReq, mwRes, next);
      });
    },
  });
}

describe("e2e: client → server payment flow", () => {
  const facilitator = createMockFacilitator();
  let server: ReturnType<typeof Bun.serve>;

  afterAll(() => {
    server?.stop();
  });

  it("completes the full 402 → pay → retry → success flow", async () => {
    await facilitator.initialize();
    server = createServer(facilitator);

    const scheme = createMockClient();
    const payFetch = wrapFetchWithPayment(fetch, scheme);

    const response = await payFetch(`http://localhost:${server.port}/api/weather`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.paid).toBe(true);
    expect(data.weather).toBe("sunny");
  });

  it("returns 402 when no payment is provided", async () => {
    const response = await fetch(`http://localhost:${server.port}/api/weather`);

    expect(response.status).toBe(402);
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
  });

  it("passes through non-gated routes", async () => {
    const response = await fetch(`http://localhost:${server.port}/other`);

    // Non-gated routes get the default Bun 404 since we don't handle them
    // The middleware calls next() which resolves with the weather response
    // but since /other isn't in routes, it goes to next() too
    expect(response.status).toBe(200);
  });
});
