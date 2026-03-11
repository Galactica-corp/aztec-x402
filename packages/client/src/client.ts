import type {
  SchemeNetworkClient,
  PaymentPayload,
  PaymentRequirements,
} from "@aztec-x402/mechanism";

type FetchFunction = typeof fetch;

interface PaymentRequired {
  x402Version: number;
  accepts: PaymentRequirements[];
}

/**
 * Wraps a fetch function with automatic x402 payment handling.
 *
 * When a request returns HTTP 402:
 * 1. Reads the PAYMENT-REQUIRED header
 * 2. Creates a payment payload using the provided scheme
 * 3. Retries the request with a PAYMENT-SIGNATURE header
 *
 * Non-402 responses pass through unchanged.
 */
export function wrapFetchWithPayment(
  fetchFn: FetchFunction,
  scheme: SchemeNetworkClient,
): FetchFunction {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    // Make the initial request
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
    let paymentRequired: PaymentRequired;
    try {
      paymentRequired = JSON.parse(
        Buffer.from(paymentRequiredHeader, "base64").toString(),
      );
    } catch {
      return response;
    }

    // Find matching scheme in accepts
    const matching = paymentRequired.accepts.find(
      (a) => a.scheme === scheme.scheme,
    );
    if (!matching) {
      return response;
    }

    // Create payment payload
    const payloadResult = await scheme.createPaymentPayload(
      paymentRequired.x402Version,
      matching,
    );

    // Build full payment payload
    const fullPayload: PaymentPayload = {
      x402Version: payloadResult.x402Version,
      accepted: matching,
      payload: payloadResult.payload,
      extensions: payloadResult.extensions,
    };

    // Encode as base64
    const encoded = Buffer.from(JSON.stringify(fullPayload)).toString("base64");

    // Merge headers
    const existingHeaders: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          existingHeaders[key] = value;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) {
          existingHeaders[key] = value;
        }
      } else {
        Object.assign(existingHeaders, init.headers);
      }
    }

    // Retry with payment
    return fetchFn(input, {
      ...init,
      headers: {
        ...existingHeaders,
        "PAYMENT-SIGNATURE": encoded,
      },
    });
  };
}
