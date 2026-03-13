/**
 * E2e-style tests for payment failure scenarios.
 *
 * These tests verify that the x402 payment flow correctly REJECTS payments
 * when the client sends to the wrong address, wrong amount, or wrong token.
 *
 * Background: Fred found that `bun run demo` succeeds even when the client
 * sends payment to a hardcoded wrong address. This is because
 * `RealFacilitatorAztecSigner.verifyPaymentNotes` only checks tx status and
 * trusts that a successful tx means correct payment. These tests ensure the
 * middleware stack catches such failures when the verifier properly validates.
 *
 * @see https://github.com/jilio/aztec-x402/blob/c654fd126f5c75cedaf63fff47048c96285993d8/packages/demo/src/aztec/facilitator-signer.ts#L68-L72
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

const WRONG_ADDRESS = "0x" + "ee".repeat(32);
const WRONG_TOKEN = "0x" + "11".repeat(32);
const WRONG_AMOUNT = "50000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a facilitator signer that actually validates payment parameters.
 * This is what a correct verifyPaymentNotes implementation should do —
 * verify recipient, token, and amount match the requirements.
 */
function createValidatingFacilitator(opts?: {
  /** Simulate: client sent payment to a different address */
  actualRecipient?: string;
  /** Simulate: client sent a different amount */
  actualAmount?: bigint;
  /** Simulate: client used a different token */
  actualToken?: string;
  /** Simulate: transaction failed on-chain */
  txFailed?: boolean;
}) {
  const signer: FacilitatorAztecSigner = {
    async getAddresses() {
      return [SERVER_ADDRESS];
    },
    async registerSender() {},
    async verifyPaymentNotes(
      _txHash: string,
      tokenAddress: string,
      recipientAddress: string,
      requiredAmount: bigint,
    ): Promise<PaymentNoteVerification> {
      if (opts?.txFailed) {
        return {
          isValid: false,
          amountFound: 0n,
          error: "transaction status is 'dropped'",
        };
      }

      const actualRecipient = opts?.actualRecipient ?? recipientAddress;
      const actualAmount = opts?.actualAmount ?? requiredAmount;
      const actualToken = opts?.actualToken ?? tokenAddress;

      // Verify recipient
      if (actualRecipient !== recipientAddress) {
        return {
          isValid: false,
          amountFound: 0n,
          error: `payment sent to wrong address: expected ${recipientAddress}, got ${actualRecipient}`,
        };
      }

      // Verify token
      if (actualToken !== tokenAddress) {
        return {
          isValid: false,
          amountFound: 0n,
          error: `wrong token contract: expected ${tokenAddress}, got ${actualToken}`,
        };
      }

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
    async transferPrivateToPrivate() {
      return "0x" + "ff".repeat(32);
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

  describe("wrong recipient address", () => {
    let server: ReturnType<typeof Bun.serve>;

    afterAll(() => {
      server?.stop();
    });

    it("rejects payment sent to the wrong address", async () => {
      const facilitator = createValidatingFacilitator({
        actualRecipient: WRONG_ADDRESS,
      });
      await facilitator.initialize();
      server = createServer(facilitator);

      const scheme = createMockClient();
      const payFetch = wrapFetchWithPayment(fetch, scheme);

      const response = await payFetch(
        `http://localhost:${server.port}/api/weather/wrong-addr`,
      );

      // The payment should be rejected — the client paid the wrong address
      expect(response.status).not.toBe(200);
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

  describe("wrong token", () => {
    let server: ReturnType<typeof Bun.serve>;

    afterAll(() => {
      server?.stop();
    });

    it("rejects payment made with wrong token contract", async () => {
      const facilitator = createValidatingFacilitator({
        actualToken: WRONG_TOKEN,
      });
      await facilitator.initialize();
      server = createServer(facilitator);

      const scheme = createMockClient();
      const payFetch = wrapFetchWithPayment(fetch, scheme);

      const response = await payFetch(
        `http://localhost:${server.port}/api/weather/wrong-token`,
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
