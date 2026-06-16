import type {
  FacilitatorAztecSigner,
  AztecNetwork,
} from "@galactica-net/x402-core";
import { ExactAztecFacilitatorScheme } from "@galactica-net/x402-mechanism/exact/facilitator";
import { createPaymentMiddleware } from "@galactica-net/x402-middleware";
import type {
  MiddlewareRequest,
  MiddlewareResponse,
  NextFunction,
} from "@galactica-net/x402-middleware";
import type { RoutesConfig } from "@galactica-net/x402-middleware";

const PORT = 4402;
const NETWORK: AztecNetwork = "aztec:sandbox";
const SERVER_ADDRESS = "0x" + "bb".repeat(32);
const TOKEN_ADDRESS = "0x" + "dd".repeat(32);
const PRICE_AMOUNT = "100000"; // $0.10 with 6 decimals

// ---------------------------------------------------------------------------
// Mock facilitator signer — simulates PXE note discovery
// ---------------------------------------------------------------------------

let callCount = 0;

const mockFacilitatorSigner: FacilitatorAztecSigner = {
  async getAddresses() {
    return [SERVER_ADDRESS];
  },

  async registerSender(_senderAddress: string) {
    // In production, this registers the sender in PXE
    // so we can discover notes sent by them
  },

  async getPrivateBalance(_tokenAddress: string, _ownerAddress: string) {
    // Simulates balance increasing after note discovery.
    // First call (before register): 0
    // Second call (after register): payment amount received
    callCount++;
    if (callCount % 2 === 1) return 0n;
    return BigInt(PRICE_AMOUNT);
  },
};

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const facilitator = new ExactAztecFacilitatorScheme(
  mockFacilitatorSigner,
  [NETWORK],
);
await facilitator.initialize();

const routes: RoutesConfig = {
  "/api/weather": {
    network: NETWORK,
    asset: TOKEN_ADDRESS,
    amount: PRICE_AMOUNT,
    payTo: SERVER_ADDRESS,
    maxTimeoutSeconds: 60,
    description: "Current weather data — costs $0.10 per request",
  },
};

const middleware = createPaymentMiddleware(routes, { facilitator });

// Adapt Bun.serve to the Express-style middleware interface
function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Health check
  if (url.pathname === "/health") {
    return Promise.resolve(
      Response.json({ status: "ok", gatedRoutes: Object.keys(routes) }),
    );
  }

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
            headers: {
              "content-type": "application/json",
              ...responseHeaders,
            },
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
      // Payment verified — return the actual resource
      resolve(
        new Response(
          JSON.stringify({
            location: "Aztec Network",
            temperature: 21,
            conditions: "Clear skies, private transactions flowing smoothly",
            paid: true,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              ...responseHeaders,
            },
          },
        ),
      );
    };

    middleware(mwReq, mwRes, next);
  });
}

const server = Bun.serve({
  port: PORT,
  fetch: handleRequest,
});

console.log(`x402 demo server running on http://localhost:${server.port}`);
console.log(`  GET /health          — server info`);
console.log(`  GET /api/weather     — payment-gated ($0.10)`);
