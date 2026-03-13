/**
 * x402 on Aztec — Core Types
 *
 * These types define the Aztec-specific payload and signer abstractions
 * used by the x402 mechanism plugin. The payment flow uses the commitment-based
 * pattern from the forked x402 token contract:
 *
 * 1. Server calls prepare_private_balance_increase(serverAddr, clientAddr) — partial note
 * 2. Server returns commitment to client in 402 response
 * 3. Client calls finalize_transfer_to_private_from_private(clientAddr, {commitment}, amount, 0)
 * 4. Client sends txHash to server
 * 5. Server verifies tx status + note creation
 *
 * The server controls `to` (its own address), providing structural recipient
 * verification. The `completer` parameter ensures only the specified client
 * can finalize the transfer.
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
 * The client signer:
 * 1. Provides its Aztec address
 * 2. Completes a transfer to a server-provided commitment
 */
export interface ClientAztecSigner {
  /** The payer's Aztec address */
  getAddress(): Promise<string>;

  /**
   * Complete a private payment using a server-provided commitment.
   *
   * Calls `finalize_transfer_to_private_from_private(clientAddr, {commitment}, amount, 0)`
   * on the Aztec token contract. The commitment was created by the
   * server via `prepare_private_balance_increase(serverAddr)`.
   *
   * @param tokenAddress - The token contract address
   * @param commitment - The commitment Field from the server's prepare step
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
 * capabilities for creating commitments and verifying payments.
 *
 * The facilitator creates commitments via `prepare_private_balance_increase`
 * and verifies completed transfers.
 */
export interface FacilitatorAztecSigner {
  /** Get all facilitator addresses for supported networks */
  getAddresses(): Promise<string[]>;

  /**
   * Create a commitment (partial note) for the facilitator's address.
   *
   * Calls `prepare_private_balance_increase(facilitatorAddr, completerAddr)` on the
   * forked x402 token contract. The resulting commitment binds the partial note to
   * the facilitator's address (recipient) and the client's address (completer) —
   * only the specified client can finalize the transfer TO the facilitator.
   *
   * @param tokenAddress - The token contract address
   * @param completerAddress - The client's address (will call finalize_transfer_to_private_from_private)
   * @returns The commitment Field value as a string
   */
  prepareCommitment(
    tokenAddress: string,
    completerAddress: string,
  ): Promise<string>;

  /**
   * Verify that a transfer completed correctly.
   *
   * Checks tx status and verifies that the transaction produced private
   * notes. Recipient is structurally guaranteed because the server created
   * the commitment for its own address.
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
