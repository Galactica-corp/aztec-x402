/**
 * E2e-style tests for payment failure scenarios.
 *
 * These tests verify that the x402 payment flow correctly REJECTS payments
 * when the facilitator's verifyPayment reports issues (wrong amount, failed tx,
 * etc.). With the server-side commitment pattern, recipient verification
 * is structural (the facilitator creates the partial note for its own address),
 * so wrong-address scenarios are structurally prevented.
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
 * The commitment flow is server-side — the facilitator creates the commitment
 * and then verifies the completed transfer.
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
    async prepareCommitment() {
      return "0x" + "ff".repeat(32);
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

describe("payment failure scenarios (commitment-based)", () => {
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

  describe("no private notes in transaction", () => {
    let server: ReturnType<typeof Bun.serve>;

    afterAll(() => {
      server?.stop();
    });

    it("rejects payment when transaction produced no private notes", async () => {
      const signer: FacilitatorAztecSigner = {
        async getAddresses() { return [SERVER_ADDRESS]; },
        async prepareCommitment() { return "0x" + "ff".repeat(32); },
        async verifyPayment(): Promise<PaymentNoteVerification> {
          return {
            isValid: false,
            amountFound: 0n,
            error: "transaction produced no private notes — not a valid private transfer",
          };
        },
      };

      const facilitator = new ExactAztecFacilitatorScheme(signer, [NETWORK]);
      await facilitator.initialize();
      server = createServer(facilitator);

      const scheme = createMockClient();
      const payFetch = wrapFetchWithPayment(fetch, scheme);

      const response = await payFetch(
        `http://localhost:${server.port}/api/weather/no-notes`,
      );

      expect(response.status).not.toBe(200);
    });
  });

  describe("wrong token contract", () => {
    let server: ReturnType<typeof Bun.serve>;

    afterAll(() => {
      server?.stop();
    });

    it("rejects payment against a different token than required", async () => {
      const WRONG_TOKEN = "0x" + "ee".repeat(32);

      const signer: FacilitatorAztecSigner = {
        async getAddresses() { return [SERVER_ADDRESS]; },
        async prepareCommitment() { return "0x" + "ff".repeat(32); },
        async verifyPayment(
          _txHash: string,
          tokenAddress: string,
          requiredAmount: bigint,
        ): Promise<PaymentNoteVerification> {
          // A real implementation would verify that the tx interacted with
          // the correct token contract. For now, this simulates the check.
          if (tokenAddress !== TOKEN_ADDRESS) {
            return {
              isValid: false,
              amountFound: 0n,
              error: `wrong token: expected ${TOKEN_ADDRESS}, got ${tokenAddress}`,
            };
          }
          return { isValid: true, amountFound: requiredAmount };
        },
      };

      const facilitator = new ExactAztecFacilitatorScheme(signer, [NETWORK]);
      await facilitator.initialize();

      // Override routes to use wrong token
      const routes: RoutesConfig = {
        "/api/weather/:id": {
          network: NETWORK,
          asset: WRONG_TOKEN,
          amount: AMOUNT,
          payTo: SERVER_ADDRESS,
          maxTimeoutSeconds: 60,
        },
      };
      const middleware = createPaymentMiddleware(routes, { facilitator });

      server = Bun.serve({
        port: 0,
        fetch(req: Request) {
          const url = new URL(req.url);
          return new Promise((resolve) => {
            const headers: Record<string, string> = {};
            req.headers.forEach((value, key) => { headers[key] = value; });
            const mwReq: MiddlewareRequest = { path: url.pathname, method: req.method, url: req.url, headers };
            let statusCode = 200;
            const responseHeaders: Record<string, string> = {};
            const mwRes: MiddlewareResponse = {
              statusCode,
              status(code: number) { statusCode = code; return mwRes; },
              setHeader(key: string, value: string) { responseHeaders[key] = value; return mwRes; },
              json(data: unknown) {
                resolve(new Response(JSON.stringify(data), { status: statusCode, headers: { "content-type": "application/json", ...responseHeaders } }));
                return mwRes;
              },
              end() { resolve(new Response(null, { status: statusCode, headers: responseHeaders })); return mwRes; },
            };
            const next: NextFunction = () => {
              resolve(new Response(JSON.stringify({ weather: "sunny", paid: true }), { status: 200, headers: { "content-type": "application/json", ...responseHeaders } }));
            };
            middleware(mwReq, mwRes, next);
          });
        },
      });

      const scheme = createMockClient();
      const payFetch = wrapFetchWithPayment(fetch, scheme);

      const response = await payFetch(
        `http://localhost:${server.port}/api/weather/wrong-token`,
      );

      expect(response.status).not.toBe(200);
    });
  });

  describe("wrong recipient address", () => {
    let server: ReturnType<typeof Bun.serve>;

    afterAll(() => {
      server?.stop();
    });

    it("rejects payment sent to wrong address", async () => {
      const WRONG_ADDRESS = "0x" + "99".repeat(32);

      // Simulate a facilitator that detects payment was sent to wrong recipient.
      // With the commitment pattern, this is structurally prevented at the contract
      // level. But verification should still check as a defense-in-depth measure.
      const signer: FacilitatorAztecSigner = {
        async getAddresses() { return [SERVER_ADDRESS]; },
        async prepareCommitment() { return "0x" + "ff".repeat(32); },
        async verifyPayment(): Promise<PaymentNoteVerification> {
          return {
            isValid: false,
            amountFound: 0n,
            error: `payment sent to wrong recipient: ${WRONG_ADDRESS} instead of ${SERVER_ADDRESS}`,
          };
        },
      };

      const facilitator = new ExactAztecFacilitatorScheme(signer, [NETWORK]);
      await facilitator.initialize();
      server = createServer(facilitator);

      const scheme = createMockClient();
      const payFetch = wrapFetchWithPayment(fetch, scheme);

      const response = await payFetch(
        `http://localhost:${server.port}/api/weather/wrong-address`,
      );

      expect(response.status).not.toBe(200);
    });
  });

  describe("commitment not issued by facilitator", () => {
    let server: ReturnType<typeof Bun.serve>;

    afterAll(() => {
      server?.stop();
    });

    it("rejects payment with a fabricated commitment", async () => {
      // The facilitator tracks which commitments it issued. A client cannot
      // fabricate a commitment and have it accepted.
      const facilitator = createValidatingFacilitator();
      await facilitator.initialize();
      server = createServer(facilitator);

      // Manually craft a payment with a commitment the facilitator never issued
      const nonce = await getInitialNonce(server);
      const fakeCommitment = "0x" + "12".repeat(32);

      const paymentPayload = {
        x402Version: 2,
        accepted: {
          scheme: "exact",
          network: NETWORK,
          asset: TOKEN_ADDRESS,
          amount: AMOUNT,
          payTo: SERVER_ADDRESS,
          maxTimeoutSeconds: 60,
          extra: { nonce, commitment: fakeCommitment },
        },
        payload: {
          senderAddress: SENDER_ADDRESS,
          correlationId: "test-fake-commitment",
          txHash: "0x" + "cc".repeat(32),
          timestamp: new Date().toISOString(),
        },
      };

      const encoded = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
      const response = await fetch(
        `http://localhost:${server.port}/api/weather/fake-commitment`,
        { headers: { "PAYMENT-SIGNATURE": encoded } },
      );

      expect(response.status).not.toBe(200);
    });
  });
});

/** Helper: make an initial request to get a nonce from the 402 response */
async function getInitialNonce(server: ReturnType<typeof Bun.serve>): Promise<string> {
  const response = await fetch(`http://localhost:${server.port}/api/weather/nonce-probe`);
  const header = response.headers.get("PAYMENT-REQUIRED");
  if (!header) throw new Error("No PAYMENT-REQUIRED header");
  const decoded = JSON.parse(Buffer.from(header, "base64").toString());
  return decoded.accepts[0].extra.nonce;
}
