/**
 * x402 on Aztec — Core Types
 *
 * These types define the Aztec-specific payload and signer abstractions
 * used by the x402 mechanism plugin. The payment flow uses direct private
 * transfers:
 *
 * 1. Client receives 402 with payTo address
 * 2. Client calls transfer_private_to_private(from, payTo, amount, nonce)
 * 3. Facilitator verifies payment via tx status and tx effects
 */

// ---------------------------------------------------------------------------
// Network & Asset
// ---------------------------------------------------------------------------

/** CAIP-2 network identifier for Aztec networks */
export type AztecNetwork = `aztec:${string}`;

/** Well-known Aztec network identifiers */
export const AZTEC_NETWORKS = {
  /** Local sandbox for development */
  SANDBOX: "aztec:sandbox",
  /** Aztec v4 devnet */
  DEVNET: "aztec:devnet",
} as const satisfies Record<string, AztecNetwork>;

/** Scheme name — we reuse "exact" since payment is 1:1 amount match */
export const SCHEME = "exact" as const;

/** CAIP family pattern for Aztec networks */
export const CAIP_FAMILY = "aztec:*" as const;

// ---------------------------------------------------------------------------
// Payment Payload (Aztec-specific)
// ---------------------------------------------------------------------------

/**
 * The Aztec-specific payload carried inside PaymentPayload.payload.
 *
 * Direct transfer flow:
 * 1. Client transfers tokens to the facilitator's payTo address
 * 2. Facilitator verifies tx status and tx effects
 */
export interface ExactAztecPayload {
  /** The sender's Aztec address (hex string) */
  senderAddress: string;

  /** Unique correlation ID to match this payment to the request */
  correlationId: string;

  /**
   * The transaction hash of the finalized private transfer.
   * Used by the facilitator to check tx status and verify payment completion.
   */
  txHash: string;

  /** Timestamp when the payment was submitted (ISO 8601) */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Signer Abstractions
// ---------------------------------------------------------------------------

/**
 * Client-side signer — represents the payer's wallet capabilities.
 *
 * The client signer needs to:
 * 1. Provide its Aztec address
 * 2. Transfer tokens directly to the facilitator's payTo address
 */
export interface ClientAztecSigner {
  /** The payer's Aztec address */
  getAddress(): Promise<string>;

  /**
   * Execute a direct private transfer to the facilitator.
   *
   * Calls `transfer_private_to_private(from, payTo, amount, nonce)` on
   * the token contract to send tokens to the facilitator's address.
   *
   * @param tokenAddress - The token contract address
   * @param payTo - The facilitator's Aztec address to pay
   * @param amount - Amount in smallest token units
   * @returns Transaction hash
   */
  finalizePayment(
    tokenAddress: string,
    payTo: string,
    amount: bigint,
  ): Promise<string>;
}

/**
 * Facilitator/server-side signer — represents the payment receiver's
 * capabilities for verifying and acknowledging payments.
 *
 * Verifies direct private transfers by checking tx status and tx effects.
 */
export interface FacilitatorAztecSigner {
  /** Get all facilitator addresses for supported networks */
  getAddresses(): Promise<string[]>;

  /**
   * Verify that a direct private transfer completed correctly.
   *
   * Checks tx status and verifies that the transaction produced
   * private notes (indicating a valid private transfer).
   *
   * @param txHash - The transaction hash to verify
   * @param tokenAddress - The token contract address
   * @param requiredAmount - Minimum amount expected
   */
  verifyPayment(
    txHash: string,
    tokenAddress: string,
    requiredAmount: bigint,
  ): Promise<PaymentNoteVerification>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for the client-side scheme */
export interface AztecClientConfig {
  /** The client's signer (wallet) */
  signer: ClientAztecSigner;
}

/** Configuration for the facilitator-side scheme */
export interface AztecFacilitatorConfig {
  /** The facilitator's signer */
  signer: FacilitatorAztecSigner;
  /** Networks this facilitator supports */
  networks: AztecNetwork[];
}

/** Configuration for the server-side scheme */
export interface AztecServerConfig {
  /** Token decimals by token address (default: 6 for stablecoins) */
  tokenDecimals?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** Result of verifying payment notes for a specific transaction */
export interface PaymentNoteVerification {
  /** Whether the payment notes meet the required amount */
  isValid: boolean;
  /** Total amount found in the payment notes */
  amountFound: bigint;
  /** Error description when isValid is false */
  error?: string;
}
