import { v7 as uuidv7 } from "uuid";
import type { PaymentPayload, PaymentRequirements } from "@galactica-net/x402-mechanism";
import { PaymentPayloadSchema } from "@galactica-net/x402-mechanism";
import {
  AztecPrepareRequestSchema,
  OFFCHAIN_MESSAGE_TTL_MS,
  RefAztecPayloadSchema,
  parseAztecPaymentExtra,
  payloadMode,
  type AztecPrepareRequest,
  type PaymentMode,
  type PaymentStateStore,
} from "@galactica-net/x402-core";
import { assertSecret, derivePaymentRef, isPaymentRefFor, nonceCreatedAt } from "./reference.js";
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

  const usesModes = Object.values(routes).some((r) => modesOf(r).some((m) => m !== "commitment"));
  if (usesModes) {
    if (!config.store) throw new Error("ref and split payments need a durable store (MiddlewareConfig.store).");
    if (!config.secret) throw new Error("ref and split payments need a secret (MiddlewareConfig.secret).");
    assertSecret(config.secret);
  }
  const retentionMs = config.retentionMs ?? OFFCHAIN_MESSAGE_TTL_MS;
  const maxHeaderBytes = config.maxPaymentHeaderBytes ?? 16 * 1024;
  /** References being verified in this process; the store's served mark is what counts across processes. */
  const verifying = new Set<string>();
  let lastSweep = 0;

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
          // Take ownership so a concurrent prepare cannot send a second on-chain tx.
          pendingPayments.delete(nonce);
          try {
            const extra = await config.facilitator.preparePayment(
              routeConfig.asset,
              senderAddress,
              {
                nonce,
                timeoutMs: paymentEntry.timeoutMs,
                createdAt: paymentEntry.createdAt,
              },
            );
            const parsedExtra = parseAztecPaymentExtra(extra);
            paymentEntry.senderAddress = senderAddress;
            paymentEntry.commitment = parsedExtra.commitment;
            paymentEntry.offchainMessage = parsedExtra.offchainMessage;
            paymentEntry.prepareTxHash = parsedExtra.prepareTxHash;
            requirements.extra = { nonce, ...extra };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return send402(
              res,
              requirements,
              routeConfig.description,
              `commitment preparation failed: ${message}`,
            );
          } finally {
            pendingPayments.set(nonce, paymentEntry);
          }
        } else {
          applyPreparedExtra(requirements, nonce, paymentEntry);
        }
      } else {
        requirements.extra = { nonce };
      }

      return send402(res, requirements, routeConfig.description);
    }

    // Phase 3: Payment — client sends payment proof
    const paymentHeader = getHeader(req, "payment-signature");
    if (paymentHeader) {
      if (paymentHeader.length > maxHeaderBytes) {
        return send402(res, requirements, routeConfig.description, "payment header too large");
      }
      let paymentPayload: PaymentPayload;
      let nonce: string | undefined;
      try {
        const decoded = Buffer.from(paymentHeader, "base64").toString();
        paymentPayload = PaymentPayloadSchema.parse(JSON.parse(decoded));
        nonce = parseAztecPaymentExtra(paymentPayload.accepted.extra).nonce;
      } catch (error) {
        return send402(
          res,
          requirements,
          routeConfig.description,
          formatParseError("Invalid payment payload", error),
        );
      }

      if (!nonce) {
        return send402(res, requirements, routeConfig.description, "missing payment nonce");
      }

      const mode = payloadMode(paymentPayload.payload);
      if (mode === "ref" || mode === "split") {
        return handleModePayment(mode, nonce, paymentPayload, routeConfig, requirements, timeoutMs, res, next);
      }

      const paymentEntry = pendingPayments.get(nonce);
      if (!paymentEntry) {
        return send402(res, requirements, routeConfig.description, "invalid or expired payment nonce");
      }

      if (Date.now() - paymentEntry.createdAt > paymentEntry.timeoutMs) {
        pendingPayments.delete(nonce);
        return send402(res, requirements, routeConfig.description, "invalid or expired payment nonce");
      }

      // Take ownership before the first await so overlapping replays cannot both pass.
      pendingPayments.delete(nonce);
      applyPreparedExtra(requirements, nonce, paymentEntry);

      try {
        const verifyResult = await config.facilitator.verify(
          paymentPayload,
          requirements,
        );

        if (!verifyResult.isValid) {
          const retryable = isRetryableVerifyResponse(verifyResult);
          if (retryable) {
            pendingPayments.set(nonce, paymentEntry);
          }
          return send402(
            res,
            requirements,
            routeConfig.description,
            verifyResult.invalidMessage || verifyResult.invalidReason,
            retryable,
          );
        }

        const settleResult = await config.facilitator.settle(
          paymentPayload,
          requirements,
        );

        if (!settleResult.success) {
          pendingPayments.set(nonce, paymentEntry);
          res.status(500).json({
            error: "Payment settlement failed",
            reason: settleResult.errorReason,
            message: settleResult.errorMessage,
          });
          return;
        }

        const responsePayload = Buffer.from(
          JSON.stringify(settleResult),
        ).toString("base64");
        res.setHeader("PAYMENT-RESPONSE", responsePayload);
        next();
        return;
      } catch (error) {
        pendingPayments.set(nonce, paymentEntry);
        const message = error instanceof Error ? error.message : String(error);
        return send402(
          res,
          requirements,
          routeConfig.description,
          `verification error: ${message}`,
        );
      }
    }

    // Phase 1: Initial request — generate nonce, return 402
    const nonce = uuidv7();
    pendingPayments.set(nonce, { createdAt: Date.now(), timeoutMs });
    requirements.extra = { nonce };

    // Lazy-sweep expired entries
    sweepExpiredPayments(pendingPayments);

    return send402(res, await offers(nonce, routeConfig, requirements), routeConfig.description);
  };

  /**
   * One `accepts` entry per mode the facilitator can take now, all with this
   * nonce. The commitment flow's entry alone when the route offers nothing
   * else, or when asking the facilitator fails (the buyer can still pay).
   */
  async function offers(
    nonce: string,
    routeConfig: RouteConfig,
    requirements: PaymentRequirements,
  ): Promise<PaymentRequirements[]> {
    const modes = modesOf(routeConfig);
    const commitmentOnly = [{ ...requirements, extra: { nonce } }];
    if (!modes.some((m) => m !== "commitment") || !config.facilitator.offerPayment || !config.secret) {
      return commitmentOnly;
    }
    const paymentRef = derivePaymentRef(config.secret, termsOf(nonce, routeConfig, routeConfig.amount));
    try {
      const { offers } = await config.facilitator.offerPayment(routeConfig.asset, routeConfig.amount, modes, paymentRef);
      if (offers.length === 0) return commitmentOnly;
      return offers.map((o) => ({ ...requirements, extra: { nonce, ...o.extra } }));
    } catch {
      return modes.includes("commitment") ? commitmentOnly : [];
    }
  }

  /**
   * A `ref` or `split` payment: the reference must be the one derived for
   * this nonce and the quoted price, unexpired and not served. The proof is
   * stored before anything acts on it, and the reference is marked served
   * (atomically, in the store) before the resource is.
   */
  async function handleModePayment(
    mode: "ref" | "split",
    nonce: string,
    paymentPayload: PaymentPayload,
    routeConfig: RouteConfig,
    baseRequirements: PaymentRequirements,
    timeoutMs: number,
    res: MiddlewareResponse,
    next: NextFunction,
  ): Promise<void> {
    const store = config.store;
    const secret = config.secret;
    const accepted = paymentPayload.accepted;
    const offered = [{ ...accepted }];
    const refuse = (error: string, retryable = false) =>
      send402(res, retryable ? offered : [{ ...baseRequirements, extra: {} }], routeConfig.description, error, retryable);

    if (!store || !secret || !modesOf(routeConfig).includes(mode)) {
      return refuse(`payment mode "${mode}" is not offered for this resource`);
    }
    const extra = parseAztecPaymentExtra(accepted.extra);
    const paymentRef = extra.paymentRef;
    const price = accepted.amount;
    if (!paymentRef || !/^[0-9]{1,78}$/.test(price) || !isPaymentRefFor(secret, termsOf(nonce, routeConfig, price), paymentRef)) {
      return refuse("invalid payment reference");
    }
    const createdAt = nonceCreatedAt(nonce);
    if (createdAt === undefined || Date.now() > createdAt + timeoutMs + retentionMs) {
      return refuse("invalid or expired payment nonce");
    }
    if (paymentPayload.payload.paymentRef !== paymentRef) {
      return refuse("the payment names another reference");
    }
    if (mode === "ref") {
      // Refuse a proof whose messages are not for this merchant and token before it is stored.
      const proof = RefAztecPayloadSchema.safeParse(paymentPayload.payload);
      if (!proof.success) return refuse("malformed payment proof");
      const foreign = proof.data.messages.some(
        (m) => !sameHex(m.recipient, routeConfig.payTo) || !sameHex(m.contractAddress, routeConfig.asset),
      );
      if (foreign) return refuse("the payment proof is for another account or token");
    }

    sweepStore(store);
    if (await store.isServed(paymentRef)) return refuse("payment already used");

    const stored = await store.saveProof({
      paymentRef,
      nonce,
      mode,
      asset: routeConfig.asset,
      payload: JSON.stringify(paymentPayload.payload),
      price,
      receivedAt: Date.now(),
      takenIn: false,
    });
    if (!stored) return refuse("too many different proofs for this payment reference");

    if (verifying.has(paymentRef)) return refuse("payment verification in progress", true);
    verifying.add(paymentRef);
    try {
      const requirements: PaymentRequirements = {
        ...baseRequirements,
        amount: price,
        extra: { nonce, mode, paymentRef },
      };
      const verified = await config.facilitator.verify(paymentPayload, requirements);
      if (!verified.isValid) {
        return refuse(verified.invalidMessage || verified.invalidReason || "payment verification failed", isRetryableVerifyResponse(verified));
      }
      if (mode === "ref") {
        await store.markTakenIn(paymentRef);
      } else {
        const claim = verified.extensions?.splitClaim;
        if (typeof claim !== "string") {
          res.status(500).json({ error: "Payment settlement failed", reason: "the facilitator returned no split claim" });
          return;
        }
        const now = Date.now();
        await store.saveSplitClaim({
          paymentRef,
          asset: routeConfig.asset,
          claim,
          status: "pending",
          attempts: 0,
          nextTryAt: now,
          updatedAt: now,
        });
      }
      if (!(await store.markServed(paymentRef, nonce))) return refuse("payment already used");

      const settled = await config.facilitator.settle(paymentPayload, requirements);
      res.setHeader("PAYMENT-RESPONSE", Buffer.from(JSON.stringify(settled)).toString("base64"));
      next();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return refuse(`verification error: ${message}`, true);
    } finally {
      verifying.delete(paymentRef);
    }
  }

  /** At most hourly: forget served marks and proofs no reference can reach any more. */
  function sweepStore(store: PaymentStateStore): void {
    const now = Date.now();
    if (now - lastSweep < 60 * 60 * 1000) return;
    lastSweep = now;
    const longestQuote = Math.max(...Object.values(routes).map((r) => (r.maxTimeoutSeconds ?? 120) * 1000));
    store.sweep(now - longestQuote - retentionMs - OFFCHAIN_MESSAGE_TTL_MS).catch(() => undefined);
  }
}

function modesOf(route: RouteConfig): PaymentMode[] {
  return route.modes && route.modes.length > 0 ? route.modes : ["commitment"];
}

function termsOf(nonce: string, route: RouteConfig, price: string) {
  return { nonce, network: route.network, asset: route.asset, payTo: route.payTo, price };
}

function sameHex(a: string, b: string): boolean {
  const norm = (x: string) => BigInt(x).toString(16);
  try {
    return norm(a) === norm(b);
  } catch {
    return false;
  }
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

function applyPreparedExtra(
  requirements: PaymentRequirements,
  nonce: string,
  paymentEntry: PendingPayment,
): void {
  if (!paymentEntry.commitment) return;
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

function isRetryableVerifyResponse(result: { extensions?: Record<string, unknown> }): boolean {
  return result.extensions?.retryable === true;
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
  requirements: PaymentRequirements | PaymentRequirements[],
  description?: string,
  error?: string,
  retryable = false,
): void {
  const paymentRequired = {
    x402Version: 2,
    error,
    resource: { description },
    accepts: Array.isArray(requirements) ? requirements : [requirements],
    ...(retryable ? { retryable: true } : {}),
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
