/**
 * x402 protocol types — mirrors the interfaces from @x402/core.
 *
 * We define these locally rather than depending on @x402/core (the Coinbase
 * package) so that this plugin can be used standalone or integrated into
 * the x402 ecosystem. The shapes are compatible with x402 v2.
 */

/** CAIP-2 network identifier */
export type Network = `${string}:${string}`;

/** A price can be a human-readable string/number or a structured asset amount */
export type Price = string | number | AssetAmount;

export interface AssetAmount {
  asset: string;
  amount: string;
  extra?: Record<string, unknown>;
}

/** What the server tells the client it needs to pay */
export interface PaymentRequirements {
  scheme: string;
  network: Network;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

/** What the client sends back as proof of payment */
export interface PaymentPayload {
  x402Version: number;
  resource?: { url: string; method: string };
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

/** Result from createPaymentPayload */
export interface PaymentPayloadResult {
  x402Version: number;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

/** Context passed to createPaymentPayload */
export interface PaymentPayloadContext {
  extensions?: Record<string, unknown>;
}

/** Result of payment verification */
export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
  extensions?: Record<string, unknown>;
}

/** Result of payment settlement */
export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  transaction: string;
  network: Network;
  extensions?: Record<string, unknown>;
}

/** Context for facilitator operations */
export interface FacilitatorContext {
  getExtension<T>(key: string): T | undefined;
}

/** Information about a supported scheme+network from the facilitator */
export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: Network;
  extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Plugin Interfaces — what a mechanism plugin must implement
// ---------------------------------------------------------------------------

/** Client-side: creates signed payment payloads */
export interface SchemeNetworkClient {
  readonly scheme: string;

  /** Get the sender's address (used by the client wrapper for the prepare phase) */
  getSenderAddress?(): Promise<string>;

  createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult>;
}

/** Facilitator-side: verifies and settles payments */
export interface SchemeNetworkFacilitator {
  readonly scheme: string;
  readonly caipFamily: string;

  getExtra(network: Network): Record<string, unknown> | undefined;
  getSigners(network: string): string[];

  /**
   * Prepare a commitment for a pending payment.
   *
   * Called by the middleware during the prepare phase. The client sends
   * its address, and the facilitator creates a commitment via
   * `prepare_private_balance_increase(facilitatorAddr)`.
   *
   * The returned record is merged into PaymentRequirements.extra
   * (includes `commitment`).
   *
   * @param tokenAddress - The token contract address
   * @param completerAddress - The client's Aztec address
   * @returns Extra data to merge into requirements.extra
   */
  preparePayment?(
    tokenAddress: string,
    completerAddress: string,
  ): Promise<Record<string, unknown>>;

  verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<VerifyResponse>;

  settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse>;
}

/** Server-side: parses prices and enhances payment requirements */
export interface SchemeNetworkServer {
  readonly scheme: string;

  parsePrice(price: Price, network: Network): Promise<AssetAmount>;

  enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: SupportedKind,
    facilitatorExtensions: string[],
  ): Promise<PaymentRequirements>;
}
