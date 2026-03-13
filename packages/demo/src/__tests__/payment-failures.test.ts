/**
 * E2e-style tests for payment failure scenarios.
 *
 * These tests verify that the x402 payment flow correctly REJECTS payments
 * when the facilitator's verifyPayment reports issues (wrong amount, failed tx,
 * etc.).
 *
 * Each describe block spins up its own Bun.serve on port 0 (OS-assigned) because
 * the facilitator is configured per-scenario (different mock verification behavior).
 * Servers are stopped in afterAll to free ports.
 */
import { describe, it, expect, afterAll } from "bun:test";
import type {
  ClientAztecSigner,
  FacilitatorAztecSigner,
  AztecNetwork,
  PaymentNoteVerification,
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
const WRONG_AMOUNT = "50000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a facilitator signer that validates payment parameters.
 * Uses direct transfer verification (verifyPayment only).
 */
function createValidatingFacilitator(opts?: {
  /** Simulate: client sent a different amount */
  actualAmount?: bigint;
  /** Simulate: transaction failed on-chain */
  txFailed?: boolean;
}) {
  const signer: FacilitatorAztecSigner = {
    async getAddresses() {
      return [SERVER_ADDRESS];
    },
    async verifyPayment(
      _txHash: string,
      _tokenAddress: string,
      requiredAmount: bigint,
    ): Promise<PaymentNoteVerification> {
      if (opts?.txFailed) {
        return {
          isValid: false,
          amountFound: 0n,
          error: "transaction status is 'dropped'",
        };
      }

      const actualAmount = opts?.actualAmount ?? requiredAmount;

      // Verify amount
      if (actualAmount < requiredAmount) {
        return {
          isValid: false,
          amountFound: actualAmount,
          error: `insufficient payment: found ${actualAmount}, need ${requiredAmount}`,
        };
      }

      return { isValid: true, amountFound: actualAmount };
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
    "/api/weather/:id": {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("payment failure scenarios", () => {
  describe("correct payment is accepted", () => {
    let server: ReturnType<typeof Bun.serve>;

    afterAll(() => {
      server?.stop();
    });

    it("succeeds with valid payment", async () => {
      const facilitator = createValidatingFacilitator();
      await facilitator.initialize();
      server = createServer(facilitator);

      const scheme = createMockClient();
      const payFetch = wrapFetchWithPayment(fetch, scheme);

      const response = await payFetch(`http://localhost:${server.port}/api/weather/ok`);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.paid).toBe(true);
    });
  });

  describe("insufficient amount", () => {
    let server: ReturnType<typeof Bun.serve>;

    afterAll(() => {
      server?.stop();
    });

    it("rejects payment with insufficient amount", async () => {
      const facilitator = createValidatingFacilitator({
        actualAmount: BigInt(WRONG_AMOUNT),
      });
      await facilitator.initialize();
      server = createServer(facilitator);

      const scheme = createMockClient();
      const payFetch = wrapFetchWithPayment(fetch, scheme);

      const response = await payFetch(
        `http://localhost:${server.port}/api/weather/wrong-amount`,
      );

      expect(response.status).not.toBe(200);
    });
  });

  describe("failed transaction", () => {
    let server: ReturnType<typeof Bun.serve>;

    afterAll(() => {
      server?.stop();
    });

    it("rejects payment when on-chain transaction failed", async () => {
      const facilitator = createValidatingFacilitator({
        txFailed: true,
      });
      await facilitator.initialize();
      server = createServer(facilitator);

      const scheme = createMockClient();
      const payFetch = wrapFetchWithPayment(fetch, scheme);

      const response = await payFetch(
        `http://localhost:${server.port}/api/weather/failed-tx`,
      );

      expect(response.status).not.toBe(200);
    });
  });

});
