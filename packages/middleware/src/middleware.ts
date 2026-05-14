import { v7 as uuidv7 } from "uuid";
import type { PaymentPayload, PaymentRequirements } from "@aztec-x402/mechanism";
import { PaymentPayloadSchema } from "@aztec-x402/mechanism";
import {
  AztecPrepareRequestSchema,
  parseAztecPaymentExtra,
  type AztecPrepareRequest,
} from "@aztec-x402/core";
import type {
  RouteConfig,
  RoutesConfig,
  MiddlewareConfig,
  MiddlewareRequest,
  MiddlewareResponse,
  NextFunction,
} from "./types.js";

interface PendingPayment {
  createdAt: number;
  timeoutMs: number;
  senderAddress?: string;
  commitment?: string;
  offchainMessage?: string;
  prepareTxHash?: string;
}

/**
 * Creates x402 payment middleware for Aztec.
 *
 * 3-phase flow:
 * 1. No payment headers → return 402 with nonce (client learns requirements)
 * 2. X-402-PREPARE header with {nonce, senderAddress} → server creates
 *    commitment via initialize_transfer_commitment, returns 402 with
 *    nonce + commitment
 * 3. PAYMENT-SIGNATURE header → validate nonce + commitment, verify, settle,
 *    pass through
 *
 * The server creates the commitment for its own address with the client as
 * completer, providing structural recipient verification.
 */
export function createPaymentMiddleware(
  routes: RoutesConfig,
  config: MiddlewareConfig,
) {
  const pendingPayments = new Map<string, PendingPayment>();
  const paidResources = new Set<string>();

  return async (
    req: MiddlewareRequest,
    res: MiddlewareResponse,
    next: NextFunction,
  ): Promise<void> => {
    // Check if this route requires payment
    const match = matchRoute(req.path, routes);
    if (!match) {
      next();
      return;
    }

    const { config: routeConfig, params } = match;
    req.params = params;

    // If this exact resource was already paid for, let it through
    if (paidResources.has(req.path)) {
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

    // Phase 2: Prepare — client sends its address, server creates commitment
    const prepareHeader = getHeader(req, "x-402-prepare");
    if (prepareHeader) {
      let prepareData: AztecPrepareRequest;
      try {
        prepareData = AztecPrepareRequestSchema.parse(
          JSON.parse(Buffer.from(prepareHeader, "base64").toString()),
        );
      } catch (error) {
        return send402(
          res,
          requirements,
          routeConfig.description,
          formatParseError("Invalid prepare payload", error),
        );
      }

      const nonce = prepareData.nonce;
      const senderAddress = prepareData.senderAddress;

      const paymentEntry = pendingPayments.get(nonce);
      if (!paymentEntry) {
        return send402(res, requirements, routeConfig.description, "invalid or expired payment nonce");
      }

      if (Date.now() - paymentEntry.createdAt > paymentEntry.timeoutMs) {
        pendingPayments.delete(nonce);
        return send402(res, requirements, routeConfig.description, "invalid or expired payment nonce");
      }

      if (paymentEntry.senderAddress && paymentEntry.senderAddress !== senderAddress) {
        return send402(
          res,
          requirements,
          routeConfig.description,
          "prepare senderAddress does not match existing commitment",
        );
      }
      paymentEntry.senderAddress = senderAddress;

      // Create commitment if facilitator supports it
      if (config.facilitator.preparePayment) {
        if (!paymentEntry.commitment) {
          let extra: Record<string, unknown>;
          try {
            extra = await config.facilitator.preparePayment(
              routeConfig.asset,
              senderAddress,
              {
                nonce,
                timeoutMs: paymentEntry.timeoutMs,
                createdAt: paymentEntry.createdAt,
              },
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return send402(
              res,
              requirements,
              routeConfig.description,
              `commitment preparation failed: ${message}`,
            );
          }
          const parsedExtra = parseAztecPaymentExtra(extra);
          // Store commitment + offchain data in pending entry for validation in phase 3
          paymentEntry.senderAddress = senderAddress;
          paymentEntry.commitment = parsedExtra.commitment;
          paymentEntry.offchainMessage = parsedExtra.offchainMessage;
          paymentEntry.prepareTxHash = parsedExtra.prepareTxHash;
          requirements.extra = { nonce, ...extra };
        } else {
          requirements.extra = {
            nonce,
            commitment: paymentEntry.commitment,
          };
          if (paymentEntry.offchainMessage) {
            requirements.extra.offchainMessage = paymentEntry.offchainMessage;
          }
          if (paymentEntry.prepareTxHash) {
            requirements.extra.prepareTxHash = paymentEntry.prepareTxHash;
          }
        }
      } else {
        requirements.extra = { nonce };
      }

      return send402(res, requirements, routeConfig.description);
    }

    // Phase 3: Payment — client sends payment proof
    const paymentHeader = getHeader(req, "payment-signature");
    if (paymentHeader) {
      let paymentPayload: PaymentPayload;
      try {
        const decoded = Buffer.from(paymentHeader, "base64").toString();
        paymentPayload = PaymentPayloadSchema.parse(JSON.parse(decoded));
      } catch (error) {
        return send402(
          res,
          requirements,
          routeConfig.description,
          formatParseError("Invalid payment payload", error),
        );
      }

      // Validate nonce
      const accepted = paymentPayload.accepted;
      const nonce = parseAztecPaymentExtra(accepted.extra).nonce;
      if (!nonce) {
        return send402(res, requirements, routeConfig.description, "missing payment nonce");
      }

      const paymentEntry = pendingPayments.get(nonce);
      if (!paymentEntry) {
        return send402(res, requirements, routeConfig.description, "invalid or expired payment nonce");
      }

      if (Date.now() - paymentEntry.createdAt > paymentEntry.timeoutMs) {
        pendingPayments.delete(nonce);
        return send402(res, requirements, routeConfig.description, "invalid or expired payment nonce");
      }

      // Consume nonce (one-shot)
      pendingPayments.delete(nonce);

      // Carry commitment + offchain data from the prepare phase into verify requirements
      if (paymentEntry.commitment) {
        requirements.extra = {
          ...requirements.extra,
          nonce,
          commitment: paymentEntry.commitment,
        };
        if (paymentEntry.offchainMessage) {
          requirements.extra.offchainMessage = paymentEntry.offchainMessage;
        }
        if (paymentEntry.prepareTxHash) {
          requirements.extra.prepareTxHash = paymentEntry.prepareTxHash;
        }
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

      // Mark this resource as paid
      paidResources.add(req.path);

      // Pass through to the actual route handler
      next();
      return;
    }

    // Phase 1: Initial request — generate nonce, return 402
    const nonce = uuidv7();
    pendingPayments.set(nonce, { createdAt: Date.now(), timeoutMs });
    requirements.extra = { nonce };

    // Lazy-sweep expired entries
    sweepExpiredPayments(pendingPayments);

    return send402(res, requirements, routeConfig.description);
  };
}

function matchRoute(path: string, routes: RoutesConfig): { config: RouteConfig; params: Record<string, string> } | null {
  // Try exact match first
  if (routes[path]) return { config: routes[path], params: {} };
  // Try :param patterns
  for (const [pattern, config] of Object.entries(routes)) {
    if (!pattern.includes(":")) continue;
    const patParts = pattern.split("/");
    const pathParts = path.split("/");
    if (patParts.length !== pathParts.length) continue;
    const params: Record<string, string> = {};
    let match = true;
    for (let i = 0; i < patParts.length; i++) {
      if (patParts[i].startsWith(":")) params[patParts[i].slice(1)] = pathParts[i];
      else if (patParts[i] !== pathParts[i]) { match = false; break; }
    }
    if (match) return { config, params };
  }
  return null;
}

function sweepExpiredPayments(payments: Map<string, PendingPayment>): void {
  const now = Date.now();
  for (const [key, entry] of payments) {
    if (now - entry.createdAt > entry.timeoutMs) {
      payments.delete(key);
    }
  }
}

function formatParseError(prefix: string, error: unknown): string {
  if (error && typeof error === "object" && "issues" in error) {
    const issues = Reflect.get(error, "issues");
    if (Array.isArray(issues) && issues.length > 0) {
      const details = issues
        .map((issue) => {
          if (!issue || typeof issue !== "object") return "";
          const path = Reflect.get(issue, "path");
          const message = Reflect.get(issue, "message");
          const pathLabel = Array.isArray(path) && path.length > 0
            ? path.join(".")
            : "payload";
          return `${pathLabel}: ${String(message)}`;
        })
        .filter(Boolean)
        .join("; ");
      if (details) return `${prefix}: ${details}`;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${message}`;
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
