import type { PaymentPayload, PaymentRequirements } from "@aztech-x402/mechanism";
import type {
  RoutesConfig,
  MiddlewareConfig,
  MiddlewareRequest,
  MiddlewareResponse,
  NextFunction,
} from "./types.js";

/**
 * Creates x402 payment middleware for Aztec.
 *
 * Flow:
 * 1. Check if the request path matches a payment-gated route
 * 2. If no PAYMENT-SIGNATURE header → return 402 with PAYMENT-REQUIRED
 * 3. If PAYMENT-SIGNATURE present → decode, verify, settle, pass through
 */
export function createPaymentMiddleware(
  routes: RoutesConfig,
  config: MiddlewareConfig,
) {
  return async (
    req: MiddlewareRequest,
    res: MiddlewareResponse,
    next: NextFunction,
  ): Promise<void> => {
    // Check if this route requires payment
    const routeConfig = routes[req.path];
    if (!routeConfig) {
      next();
      return;
    }

    // Build payment requirements
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: routeConfig.network,
      asset: routeConfig.asset,
      amount: routeConfig.amount,
      payTo: routeConfig.payTo,
      maxTimeoutSeconds: routeConfig.maxTimeoutSeconds,
      extra: {},
    };

    // Check for payment header
    const paymentHeader = getHeader(req, "payment-signature");
    if (!paymentHeader) {
      return send402(res, requirements, routeConfig.description);
    }

    // Decode payment payload
    let paymentPayload: PaymentPayload;
    try {
      const decoded = Buffer.from(paymentHeader, "base64").toString();
      paymentPayload = JSON.parse(decoded);
    } catch {
      return send402(res, requirements, routeConfig.description, "Invalid payment payload encoding");
    }

    // Verify payment
    const verifyResult = await config.facilitator.verify(
      paymentPayload,
      requirements,
    );

    if (!verifyResult.isValid) {
      return send402(
        res,
        requirements,
        routeConfig.description,
        verifyResult.invalidMessage || verifyResult.invalidReason,
      );
    }

    // Settle payment
    const settleResult = await config.facilitator.settle(
      paymentPayload,
      requirements,
    );

    if (!settleResult.success) {
      res.status(500).json({
        error: "Payment settlement failed",
        reason: settleResult.errorReason,
        message: settleResult.errorMessage,
      });
      return;
    }

    // Set PAYMENT-RESPONSE header
    const responsePayload = Buffer.from(
      JSON.stringify(settleResult),
    ).toString("base64");
    res.setHeader("PAYMENT-RESPONSE", responsePayload);

    // Pass through to the actual route handler
    next();
  };
}

function send402(
  res: MiddlewareResponse,
  requirements: PaymentRequirements,
  description?: string,
  error?: string,
): void {
  const paymentRequired = {
    x402Version: 2,
    error,
    resource: { description },
    accepts: [requirements],
  };

  const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");
  res.setHeader("PAYMENT-REQUIRED", encoded);
  res.status(402).json(paymentRequired);
}

function getHeader(
  req: MiddlewareRequest,
  name: string,
): string | undefined {
  const value = req.headers[name] || req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}
