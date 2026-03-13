/**
 * x402 on Aztec — Core Types
 *
 * These types define the Aztec-specific payload and signer abstractions
 * used by the x402 mechanism plugin. The payment flow uses a commitment-based
 * pattern for verifiable private payments:
 *
 * 1. Facilitator calls prepare_private_balance_increase → gets commitment
 * 2. Commitment is sent to client in 402 response
 * 3. Client calls finalize_transfer_to_private_from_private(commitment)
 * 4. Facilitator verifies payment via its own PXE (note was created for it)
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
 * The commitment-based flow:
 * 1. Facilitator prepares a commitment via prepare_private_balance_increase
 * 2. Client finalizes the transfer using that commitment
 * 3. Facilitator verifies the completed note in its PXE
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
 * 2. Finalize a payment using a commitment from the facilitator
 */
export interface ClientAztecSigner {
  /** The payer's Aztec address */
  getAddress(): Promise<string>;

  /**
   * Finalize a private payment using a commitment from the facilitator.
   *
   * Calls `finalize_transfer_to_private_from_private` on the token contract
   * with the commitment that the facilitator prepared via
   * `prepare_private_balance_increase`.
   *
   * @param tokenAddress - The token contract address
   * @param commitment - Hex-encoded commitment Field from the 402 response
   * @param amount - Amount in smallest token units
   * @returns Transaction hash
   */
  finalizePayment(
    tokenAddress: string,
    commitment: string,
    amount: bigint,
  ): Promise<string>;
}

/**
 * Facilitator/server-side signer — represents the payment receiver's
 * capabilities for verifying and acknowledging payments.
 *
 * Uses the commitment-based pattern:
 * 1. prepareCommitment: creates a partial note for the facilitator's address
 * 2. verifyPayment: checks that the finalized transfer completed correctly
 */
export interface FacilitatorAztecSigner {
  /** Get all facilitator addresses for supported networks */
  getAddresses(): Promise<string[]>;

  /**
   * Prepare a commitment for receiving a private payment.
   *
   * Calls `prepare_private_balance_increase(facilitatorAddress)` on the token
   * contract, which creates a partial note and returns a commitment Field.
   * This commitment is sent to the client in the 402 response.
   *
   * @param tokenAddress - The token contract address
   * @returns Hex-encoded commitment Field
   */
  prepareCommitment(tokenAddress: string): Promise<string>;

  /**
   * Verify that a finalized transfer completed the commitment correctly.
   *
   * Checks tx status and verifies that the facilitator's PXE received
   * the expected payment note with at least the required amount.
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
