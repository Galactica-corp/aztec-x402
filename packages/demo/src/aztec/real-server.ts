/**
 * Real x402 demo server — connects to Aztec node,
 * gates /api/weather behind a private token payment.
 *
 * Prerequisites: run setup.ts first to deploy the token contract.
 *
 * Usage: bun run packages/demo/src/aztec/real-server.ts
 */
import * as Sentry from "@sentry/bun";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV ?? "development",
  tracesSampleRate: 1.0,
});

import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { TokenContract } from "@defi-wonderland/aztec-standards/dist/src/artifacts/Token.js";
import { createPXEWallet } from "./pxe-wallet.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { loadKeys, loadAccount, setupSponsoredPayment } from "./wallet-manager.js";

const USE_SPONSORED_FPC = process.env.USE_SPONSORED_FPC === "true";

import { AztecNetworkSchema, type AztecNetwork } from "@aztec-x402/core";
import { ExactAztecFacilitatorScheme } from "@aztec-x402/mechanism/exact/facilitator";
import { createPaymentMiddleware } from "@aztec-x402/middleware";
import type {
  MiddlewareRequest,
  MiddlewareResponse,
  NextFunction,
  RoutesConfig,
} from "@aztec-x402/middleware";
import { RealFacilitatorAztecSigner } from "./facilitator-signer.js";

const PORT = 4402;
const PRICE_AMOUNT = "10000"; // $0.01 with 6 decimals

// Load deployment config
const __dirname = dirname(new URL(import.meta.url).pathname);
const DATA_DIR = process.env.DATA_DIR ?? __dirname;
const CONFIG_PATH = join(DATA_DIR, "deploy.json");
const KEYS_PATH = join(DATA_DIR, "keys.json");

function parseAztecNetwork(value: string): AztecNetwork {
  return AztecNetworkSchema.parse(value);
}

let config: Record<string, string>;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
} catch {
  console.error("deploy.json not found. Run setup first:");
  console.error("  bun run packages/demo/src/aztec/setup.ts");
  process.exit(1);
}

const NODE_URL = config.nodeUrl;
const NETWORK = parseAztecNetwork(config.network);
const TOKEN_ADDRESS = config.tokenAddress;
const SERVER_ADDRESS = config.bobAddress;
const isDevnet = USE_SPONSORED_FPC || NETWORK !== "aztec:sandbox";

// Connect to Aztec
console.log(`Connecting to Aztec node at ${NODE_URL}...`);
const node = createAztecNodeClient(NODE_URL);
const wallet = await createPXEWallet(node, {
  ephemeral: true,
  pxeConfig: { proverEnabled: isDevnet },
});

// Get Bob's wallet (the server/facilitator)
const keys = loadKeys(KEYS_PATH);
const bobAccount = await loadAccount(wallet, keys, "bob");
const bob = bobAccount.address;
console.log(`Server address: ${bob}`);

// Load the token contract for the facilitator (needed for commitment creation)
const tokenAddress = AztecAddress.fromString(TOKEN_ADDRESS);
const tokenInstance = await node.getContract(tokenAddress);
if (tokenInstance) {
  await wallet.registerContract(tokenInstance, TokenContract.artifact);
}
const token = await TokenContract.at(tokenAddress, wallet);

// Sponsored FPC when USE_SPONSORED_FPC=true (testnet + local 4.2 networks with non-zero fees)
const paymentMethod = USE_SPONSORED_FPC ? await setupSponsoredPayment(wallet) : undefined;
const sendOpts = paymentMethod ? { fee: { paymentMethod } } : undefined;

// Create real facilitator signer
const facilitatorSigner = new RealFacilitatorAztecSigner(bobAccount, node, token, sendOpts);
const facilitator = new ExactAztecFacilitatorScheme(facilitatorSigner, [NETWORK]);
await facilitator.initialize();

// Configure payment-gated routes
const routes: RoutesConfig = {
  "/api/weather/:id": {
    network: NETWORK,
    asset: TOKEN_ADDRESS,
    amount: PRICE_AMOUNT,
    payTo: SERVER_ADDRESS,
    maxTimeoutSeconds: 600,
    description: "Current weather data — costs $0.01 per resource (real Aztec payment)",
  },
};

const middleware = createPaymentMiddleware(routes, { facilitator });

// Bun.serve adapter (same as mock demo)
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/" || url.pathname === "/health") {
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
      const resourceId = url.pathname.split("/").pop();
      resolve(
        new Response(
          JSON.stringify({
            resource: resourceId,
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
  idleTimeout: 255,
  fetch: handleRequest,
  error(error) {
    Sentry.captureException(error);
    return new Response("Internal Server Error", { status: 500 });
  },
});

console.log(`\nx402 demo server (REAL AZTEC) running on http://localhost:${server.port}`);
console.log(`  GET /health          — server info`);
console.log(`  GET /api/weather/:id — payment-gated ($0.01 oUSD per resource)`);
