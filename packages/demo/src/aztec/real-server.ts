/**
 * Real x402 demo server — connects to Aztec node,
 * gates /api/weather and /api/buy-x402-achievement behind private token payments.
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

import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { createMerchant } from "@galactica-net/x402-agent/aztec";
import { parseManifest } from "@galactica-net/inference-money-core";
import { merchantNetwork } from "./network-config.js";
import { loadKeys, merchantKeys } from "./wallet-manager.js";

const USE_SPONSORED_FPC = process.env.USE_SPONSORED_FPC === "true";

import { AztecNetworkSchema, type AztecNetwork } from "@galactica-net/x402-core";
import type { MiddlewareRequest, MiddlewareResponse, NextFunction } from "@galactica-net/x402-middleware";
import {
  X402_ACHIEVEMENT_CONTENT_TYPE,
  X402_ACHIEVEMENT_SKILL,
} from "../skills/x402-achievement.js";
import { DATA_DIR } from "./data-dir.js";

const PORT = 4402;
const PRICE_AMOUNT = "10000"; // $0.01 with 6 decimals
const ACHIEVEMENT_PATH = "/api/buy-x402-achievement";

// Load deployment config
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

const PORT_ENV = process.env.PORT ? Number(process.env.PORT) : undefined;
const NETWORK = parseAztecNetwork(config.network);
const TOKEN_ADDRESS = config.tokenAddress;
const TOKEN_SYMBOL = config.tokenSymbol ?? "tokens";

// The wallet's store was `server-pxe` before createMerchant kept it at `pxe`: move it once, with its notes.
if (existsSync(join(DATA_DIR, "server-pxe")) && !existsSync(join(DATA_DIR, "pxe"))) {
  renameSync(join(DATA_DIR, "server-pxe"), join(DATA_DIR, "pxe"));
}

// Bob is the merchant. The token is whatever setup put in deploy.json; its kind is read from the chain.
console.log(`Connecting to Aztec node at ${config.nodeUrl}...`);
const merchant = await createMerchant({
  network: merchantNetwork(NETWORK, config.nodeUrl),
  keys: await merchantKeys(loadKeys(KEYS_PATH), "bob"),
  token: TOKEN_ADDRESS,
  dataDir: DATA_DIR,
  sponsoredFees: USE_SPONSORED_FPC,
  l1RpcUrl: process.env.L1_RPC_URL ?? config.l1RpcUrl,
  manifest: config.manifestPath ? parseManifest(JSON.parse(readFileSync(config.manifestPath, "utf-8"))) : undefined,
  secret: process.env.X402_REF_SECRET ? Buffer.from(process.env.X402_REF_SECRET.replace(/^0x/, ""), "hex") : undefined,
  noSplit: process.env.SPLIT === "off",
  finalizedAbove: process.env.SPLIT_FINALIZED_ABOVE ? BigInt(process.env.SPLIT_FINALIZED_ABOVE) : undefined,
  claimPollMs: process.env.X402_CLAIM_POLL_MS ? Number(process.env.X402_CLAIM_POLL_MS) : undefined,
});
const SERVER_ADDRESS = merchant.address.toString();
console.log(`Server address: ${SERVER_ADDRESS}`);
console.log(`Charging in token ${TOKEN_ADDRESS} (${merchant.token.kind}); payment modes: ${merchant.modes.join(", ")}`);
testHooks(merchant.signer);

// Payment-gated routes: the merchant fills in network, token, address and payment modes.
const routes = {
  "/api/weather/:id": {
    amount: PRICE_AMOUNT,
    description: "Current weather data — costs $0.01 per resource (real Aztec payment)",
  },
  [ACHIEVEMENT_PATH]: {
    amount: PRICE_AMOUNT,
    description: "x402 Private Payments achievement skill (markdown) — costs $0.01 per unlock",
  },
};
const middleware = merchant.middleware(routes);

/**
 * Test-only: with X402_TEST_CRASH_BEFORE_TAKE_IN=<file>, the first ref payment
 * makes the server exit after its proof is stored and before it is taken in
 * (once: the file marks it done), so a restart must replay it.
 */
function testHooks(signer: typeof merchant.signer): void {
  const marker = process.env.X402_TEST_CRASH_BEFORE_TAKE_IN;
  if (!marker) return;
  const receive = signer.receiveRefPayment.bind(signer);
  signer.receiveRefPayment = async (...args) => {
    if (!existsSync(marker)) {
      writeFileSync(marker, "crashed\n");
      console.log("TEST HOOK: exiting after storing a proof, before taking it in.");
      process.exit(75);
    }
    return receive(...args);
  };
}

// Bun.serve adapter (same as mock demo)
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/" || url.pathname === "/health") {
    const jobs = await merchant.status();
    return Response.json({
      status: jobs.warnings.length === 0 ? "ok" : "warn",
      network: NETWORK,
      tokenAddress: TOKEN_ADDRESS,
      tokenKind: merchant.token.kind,
      paymentModes: merchant.modes,
      serverAddress: SERVER_ADDRESS,
      gatedRoutes: Object.keys(routes),
      jobs,
    });
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
      if (url.pathname === ACHIEVEMENT_PATH) {
        resolve(
          new Response(X402_ACHIEVEMENT_SKILL, {
            status: 200,
            headers: {
              "content-type": X402_ACHIEVEMENT_CONTENT_TYPE,
              ...responseHeaders,
            },
          }),
        );
        return;
      }

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
  port: PORT_ENV ?? PORT,
  idleTimeout: 255,
  fetch: handleRequest,
  error(error) {
    Sentry.captureException(error);
    return new Response("Internal Server Error", { status: 500 });
  },
});

console.log(`\nx402 demo server (REAL AZTEC) running on http://localhost:${server.port}`);
console.log(`  GET /health                      — server info`);
console.log(`  GET /api/weather/:id             — payment-gated (0.01 ${TOKEN_SYMBOL} per resource)`);
console.log(`  GET /api/buy-x402-achievement    — payment-gated skill unlock (0.01 ${TOKEN_SYMBOL})`);
