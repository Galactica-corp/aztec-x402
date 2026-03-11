import { v7 as uuidv7 } from "uuid";
import type { PaymentPayload, PaymentRequirements } from "@aztec-x402/mechanism";
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
 * 2. If no PAYMENT-SIGNATURE header → return 402 with PAYMENT-REQUIRED (includes nonce)
 * 3. If PAYMENT-SIGNATURE present → validate nonce, verify, settle, pass through
 *
 * The middleware owns a pendingNonces map for anti-replay protection.
 * Each 402 response includes a unique nonce in `extra.nonce`. The client
 * echoes it back automatically via `accepted.extra.nonce`. The nonce is
 * consumed on use and expires after `maxTimeoutSeconds`.
 */
export function createPaymentMiddleware(
  routes: RoutesConfig,
  config: MiddlewareConfig,
) {
  const pendingNonces = new Map<string, { createdAt: number; timeoutMs: number }>();

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

    const timeoutMs = (routeConfig.maxTimeoutSeconds ?? 120) * 1000;

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
      // Generate nonce and inject into requirements
      const nonce = uuidv7();
      pendingNonces.set(nonce, { createdAt: Date.now(), timeoutMs });
      requirements.extra = { nonce };

      // Lazy-sweep expired nonces
      sweepExpiredNonces(pendingNonces);

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

    // Validate nonce
    const nonce = (paymentPayload.accepted as PaymentRequirements)?.extra?.nonce as string | undefined;
    if (!nonce) {
      return send402(res, requirements, routeConfig.description, "missing payment nonce");
    }

    const nonceEntry = pendingNonces.get(nonce);
    if (!nonceEntry) {
      return send402(res, requirements, routeConfig.description, "invalid or expired payment nonce");
    }

    // Check if nonce has expired
    if (Date.now() - nonceEntry.createdAt > nonceEntry.timeoutMs) {
      pendingNonces.delete(nonce);
      return send402(res, requirements, routeConfig.description, "invalid or expired payment nonce");
    }

    // Consume nonce (one-shot)
    pendingNonces.delete(nonce);

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

function sweepExpiredNonces(
  nonces: Map<string, { createdAt: number; timeoutMs: number }>,
): void {
  const now = Date.now();
  for (const [key, entry] of nonces) {
    if (now - entry.createdAt > entry.timeoutMs) {
      nonces.delete(key);
    }
  }
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
