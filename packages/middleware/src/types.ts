import type { SchemeNetworkFacilitator, Network } from "@galactica-net/x402-mechanism";

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
}

/** Route map: path -> route config */
export type RoutesConfig = Record<string, RouteConfig>;

/** Middleware configuration */
export interface MiddlewareConfig {
  /** The facilitator scheme that verifies and settles payments */
  facilitator: SchemeNetworkFacilitator;
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
