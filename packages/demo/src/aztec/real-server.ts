/**
 * Real x402 demo server — connects to Aztec sandbox,
 * gates /api/weather behind a private token payment.
 *
 * Prerequisites: run setup.ts first to deploy the token contract.
 *
 * Usage: bun run packages/demo/src/aztec/real-server.ts
 */
import { AztecAddress, createPXEClient, waitForPXE } from "@aztec/aztec.js";
import { getDeployedTestAccountsWallets } from "@aztec/accounts/testing";
import { TokenContract } from "@aztec/noir-contracts.js/Token";
import { readFileSync } from "fs";
import { join, dirname } from "path";

import type { AztecNetwork } from "@aztech-x402/core";
import { ExactAztecFacilitatorScheme } from "@aztech-x402/mechanism/exact/facilitator";
import { createPaymentMiddleware } from "@aztech-x402/middleware";
import type {
  MiddlewareRequest,
  MiddlewareResponse,
  NextFunction,
  RoutesConfig,
} from "@aztech-x402/middleware";
import { RealFacilitatorAztecSigner } from "./facilitator-signer.js";

const PORT = 4402;
const PRICE_AMOUNT = "100000"; // $0.10 with 6 decimals

// Load deployment config
const CONFIG_PATH = join(dirname(new URL(import.meta.url).pathname), "deploy.json");
let config: Record<string, string>;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
} catch {
  console.error("deploy.json not found. Run setup first:");
  console.error("  bun run packages/demo/src/aztec/setup.ts");
  process.exit(1);
}

const PXE_URL = config.pxeUrl;
const NETWORK = config.network as AztecNetwork;
const TOKEN_ADDRESS = config.tokenAddress;
const SERVER_ADDRESS = config.bobAddress;

// Connect to Aztec
console.log(`Connecting to Aztec sandbox at ${PXE_URL}...`);
const pxe = createPXEClient(PXE_URL);
await waitForPXE(pxe);

// Get Bob's wallet (the server/facilitator)
const wallets = await getDeployedTestAccountsWallets(pxe);
const bobWallet = wallets[1];
const bob = bobWallet.getAddress();
console.log(`Server address: ${bob}`);

// Get the deployed token contract
const tokenAddress = AztecAddress.fromString(config.tokenAddress);
const token = await TokenContract.at(tokenAddress, bobWallet);

// Create real facilitator signer
const facilitatorSigner = new RealFacilitatorAztecSigner(bobWallet, token, pxe);
const facilitator = new ExactAztecFacilitatorScheme(facilitatorSigner, [NETWORK]);
await facilitator.initialize();

// Configure payment-gated routes
const routes: RoutesConfig = {
  "/api/weather": {
    network: NETWORK,
    asset: TOKEN_ADDRESS,
    amount: PRICE_AMOUNT,
    payTo: SERVER_ADDRESS,
    maxTimeoutSeconds: 120,
    description: "Current weather data — costs $0.10 per request (real Aztec payment)",
  },
};

const middleware = createPaymentMiddleware(routes, { facilitator });

// Bun.serve adapter (same as mock demo)
function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/health") {
    return Promise.resolve(
      Response.json({
        status: "ok",
        network: NETWORK,
        tokenAddress: TOKEN_ADDRESS,
        serverAddress: SERVER_ADDRESS,
        gatedRoutes: Object.keys(routes),
      }),
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
        new Response(
          JSON.stringify({
            location: "Aztec Network",
            temperature: 21,
            conditions: "Clear skies, private transactions flowing smoothly",
            paid: true,
            network: NETWORK,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", ...responseHeaders },
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

console.log(`\nx402 demo server (REAL AZTEC) running on http://localhost:${server.port}`);
console.log(`  GET /health          — server info`);
console.log(`  GET /api/weather     — payment-gated ($0.10 oUSD)`);
