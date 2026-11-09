import type {
  SchemeNetworkClient,
  PaymentPayload,
  ParsedPaymentRequired,
} from "@galactica-net/x402-mechanism";
import { PaymentRequiredSchema } from "@galactica-net/x402-mechanism";
import { parseAztecPaymentExtra } from "@galactica-net/x402-core";

type FetchFunction = typeof fetch;

export interface PaymentFetchOptions {
  /**
   * Called with the full payment payload before it is sent. A `ref` payload
   * holds the only copy of the merchant's note: persist it here, so a crash or
   * a lost response can be recovered by resending it ({@link sendPayment}).
   */
  onPayload?(payload: PaymentPayload): Promise<void> | void;
  /** Resend the same payload while the server answers 402 marked retryable (e.g. not mined or confirmed yet). */
  retry?: RetryOptions;
}

export interface RetryOptions {
  attempts: number;
  delayMs: number;
}

const DEFAULT_RETRY: RetryOptions = { attempts: 0, delayMs: 0 };

/**
 * Wraps a fetch function with automatic x402 payment handling.
 *
 * 3-request flow for Aztec commitment-based payments:
 * 1. Initial request → 402 with nonce (no commitment yet)
 * 2. Prepare request (X-402-PREPARE header) → 402 with nonce + commitment
 * 3. Payment request (PAYMENT-SIGNATURE header) → success
 *
 * The server creates the commitment for its own address during the prepare
 * phase, providing structural recipient verification.
 *
 * Non-402 responses pass through unchanged.
 */
export function wrapFetchWithPayment(
  fetchFn: FetchFunction,
  scheme: SchemeNetworkClient,
  options: PaymentFetchOptions = {},
): FetchFunction {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    // Phase 1: Make the initial request
    const response = await fetchFn(input, init);

    // If not 402, pass through
    if (response.status !== 402) {
      return response;
    }

    // Extract PAYMENT-REQUIRED header
    const paymentRequiredHeader = response.headers.get("PAYMENT-REQUIRED");
    if (!paymentRequiredHeader) {
      return response;
    }

    // Decode payment requirements
    let paymentRequired: ParsedPaymentRequired;
    try {
      paymentRequired = PaymentRequiredSchema.parse(
        JSON.parse(Buffer.from(paymentRequiredHeader, "base64").toString()),
      );
    } catch {
      return response;
    }

    // Find matching scheme in accepts
    const ofScheme = paymentRequired.accepts.filter(
      (a) => a.scheme === scheme.scheme,
    );
    const matching = scheme.selectRequirement
      ? scheme.selectRequirement(ofScheme)
      : ofScheme[0];
    if (!matching) {
      return response;
    }

    // Get nonce from the initial 402 response
    const { nonce, mode } = parseAztecPaymentExtra(matching.extra);
    if (!nonce) {
      return response;
    }

    // ref and split need no prepare: the reference is already in the 402.
    if (mode === "ref" || mode === "split") {
      const payloadResult = await scheme.createPaymentPayload(
        paymentRequired.x402Version,
        matching,
      );
      const fullPayload: PaymentPayload = {
        x402Version: payloadResult.x402Version,
        accepted: matching,
        payload: payloadResult.payload,
        extensions: payloadResult.extensions,
      };
      await options.onPayload?.(fullPayload);
      return sendPayment(fetchFn, input, init, fullPayload, options.retry);
    }

    // Phase 2: Prepare — send our address to get a commitment
    const senderAddress = await scheme.getSenderAddress?.();

    // Merge existing headers
    const existingHeaders = extractHeaders(init);

    let preparedRequirements = matching;

    if (senderAddress) {
      const prepareData = Buffer.from(
        JSON.stringify({ nonce, senderAddress }),
      ).toString("base64");

      const prepareResponse = await fetchFn(input, {
        ...init,
        headers: {
          ...existingHeaders,
          "X-402-PREPARE": prepareData,
        },
      });

      if (prepareResponse.status === 402) {
        const prepareHeader = prepareResponse.headers.get("PAYMENT-REQUIRED");
        if (prepareHeader) {
          try {
            const prepared = PaymentRequiredSchema.parse(
              JSON.parse(Buffer.from(prepareHeader, "base64").toString()),
            );
            const preparedMatch = prepared.accepts.find(
              (a) => a.scheme === scheme.scheme,
            );
            if (preparedMatch && parseAztecPaymentExtra(preparedMatch.extra).commitment) {
              preparedRequirements = preparedMatch;
            }
          } catch {
            // Fall through with original requirements
          }
        }
      }
    }

    // Phase 3: Create payment payload using the commitment from prepare phase
    const payloadResult = await scheme.createPaymentPayload(
      paymentRequired.x402Version,
      preparedRequirements,
    );

    // Build full payment payload
    const fullPayload: PaymentPayload = {
      x402Version: payloadResult.x402Version,
      accepted: preparedRequirements,
      payload: payloadResult.payload,
      extensions: payloadResult.extensions,
    };

    await options.onPayload?.(fullPayload);
    return sendPayment(fetchFn, input, init, fullPayload, options.retry);
  };
}

/**
 * Sends a payment payload with the request, as is: also how a stored payload
 * is resent after a crash or a lost response. While the server answers 402
 * marked `retryable`, waits and resends the same payload.
 */
export async function sendPayment(
  fetchFn: FetchFunction,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  payload: PaymentPayload,
  retry: RetryOptions = DEFAULT_RETRY,
): Promise<Response> {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
  const request = () =>
    fetchFn(input, {
      ...init,
      headers: {
        ...extractHeaders(init),
        "PAYMENT-SIGNATURE": encoded,
      },
    });
  let response = await request();
  for (let attempt = 0; attempt < retry.attempts && isRetryable402(response); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, retry.delayMs));
    response = await request();
  }
  return response;
}

/** A 402 whose PAYMENT-REQUIRED marks the presented payment as one that may verify later. */
export function isRetryable402(response: Response): boolean {
  if (response.status !== 402) return false;
  const header = response.headers.get("PAYMENT-REQUIRED");
  if (!header) return false;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(header, "base64").toString());
    return typeof decoded === "object" && decoded !== null && Reflect.get(decoded, "retryable") === true;
  } catch {
    return false;
  }
}

function extractHeaders(init?: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {};
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [key, value] of init.headers) {
        headers[key] = value;
      }
    } else {
      Object.assign(headers, init.headers);
    }
  }
  return headers;
}
