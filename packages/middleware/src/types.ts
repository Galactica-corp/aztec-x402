import type { SchemeNetworkFacilitator, Network } from "@galactica-net/x402-mechanism";
import type { PaymentMode, PaymentStateStore } from "@galactica-net/x402-core";

/** Configuration for a payment-gated route */
export interface RouteConfig {
  /** CAIP-2 Aztec network identifier */
  network: Network;
  /** Token contract address */
  asset: string;
  /** Payment amount in smallest token units */
  amount: string;
  /** Recipient address (server/facilitator) */
  payTo: string;
  /** Maximum payment timeout in seconds */
  maxTimeoutSeconds: number;
  /** Optional resource description */
  description?: string;
  /**
   * The payments to offer, in order of preference (default: `["commitment"]`).
   * `ref` and `split` need `store` and `secret` in the middleware config, and
   * are only offered when the facilitator can take them for `asset` now.
   */
  modes?: PaymentMode[];
}

/** Route map: path -> route config */
export type RoutesConfig = Record<string, RouteConfig>;

/** Middleware configuration */
export interface MiddlewareConfig {
  /** The facilitator scheme that verifies and settles payments */
  facilitator: SchemeNetworkFacilitator;
  /**
   * Durable state for `ref` and `split` payments: presented proofs, served
   * references and pending split claims. Shared by every server instance.
   */
  store?: PaymentStateStore;
  /**
   * At least 32 random bytes, the same for every server instance and kept
   * across restarts: payment references are derived from it.
   */
  secret?: Uint8Array;
  /**
   * How long after a quote expires a proof of it is still taken (default
   * 26 h, the offchain-message lifetime): a buyer who paid in time must not
   * lose the payment to a slow retry.
   */
  retentionMs?: number;
  /** Largest PAYMENT-SIGNATURE header accepted, in bytes (default 16 KiB). */
  maxPaymentHeaderBytes?: number;
}

/** Minimal request interface (framework-agnostic) */
export interface MiddlewareRequest {
  path: string;
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, string>;
}

/** Minimal response interface (framework-agnostic) */
export interface MiddlewareResponse {
  statusCode: number;
  status(code: number): MiddlewareResponse;
  setHeader(key: string, value: string): MiddlewareResponse;
  json(data: unknown): MiddlewareResponse;
  end(): MiddlewareResponse;
}

/** Next function for middleware chaining */
export type NextFunction = (error?: unknown) => void;
