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

    // Get nonce from the initial 402 response
    const nonce = matching.extra?.nonce as string | undefined;
    if (!nonce) {
      return response;
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
            const prepared: PaymentRequired = JSON.parse(
              Buffer.from(prepareHeader, "base64").toString(),
            );
            const preparedMatch = prepared.accepts.find(
              (a) => a.scheme === scheme.scheme,
            );
            if (preparedMatch?.extra?.commitment) {
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

    // Encode as base64
    const encoded = Buffer.from(JSON.stringify(fullPayload)).toString("base64");

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
