/**
 * x402 on Aztec — Core Types
 *
 * These types define the Aztec-specific payload and signer abstractions
 * used by the x402 mechanism plugin. The payment flow uses
 * transfer_private_to_private with sender address + correlation ID
 * for verification (since private tx hashes are opaque).
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
 * Unlike EVM (which sends a signed authorization) or Solana (which sends a
 * partially-signed transaction), Aztec private transfers are opaque — the
 * server cannot inspect the transaction contents. Instead:
 *
 * 1. Client executes transfer_private_to_private on-chain
 * 2. Client sends sender address + correlation ID to the server
 * 3. Server's PXE discovers the incoming note and verifies the amount
 */
export interface ExactAztecPayload {
  /** The sender's Aztec address (hex string) */
  senderAddress: string;

  /** Unique correlation ID to match this payment to the request */
  correlationId: string;

  /**
   * The transaction hash of the private transfer.
   * Included for record-keeping but NOT used for verification
   * (private tx contents are hidden from observers).
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
 * 1. Provide its Aztec address (for the server to register as sender)
 * 2. Execute a private transfer on the token contract
 */
export interface ClientAztecSigner {
  /** The payer's Aztec address */
  getAddress(): Promise<string>;

  /**
   * Execute a private-to-private token transfer.
   *
   * @param tokenAddress - The token contract address
   * @param to - Recipient Aztec address
   * @param amount - Amount in smallest token units
   * @returns Transaction hash (for record-keeping only)
   */
  transferPrivateToPrivate(
    tokenAddress: string,
    to: string,
    amount: bigint,
  ): Promise<string>;
}

/**
 * Facilitator/server-side signer — represents the payment receiver's
 * capabilities for verifying and acknowledging payments.
 *
 * The facilitator signer needs to:
 * 1. Provide its addresses (for PaymentRequirements)
 * 2. Register senders so PXE can discover their notes
 * 3. Check its private balance to verify payment receipt
 */
export interface FacilitatorAztecSigner {
  /** Get all facilitator addresses for supported networks */
  getAddresses(): Promise<string[]>;

  /**
   * Register a sender address so the PXE can discover notes from them.
   * Must be called before attempting to verify payment from a new sender.
   *
   * @param senderAddress - The sender's Aztec address
   */
  registerSender(senderAddress: string): Promise<void>;

  /**
   * Get the private token balance for a specific address.
   *
   * @param tokenAddress - The token contract address
   * @param ownerAddress - The address to check balance for
   * @returns Balance in smallest token units
   */
  getPrivateBalance(
    tokenAddress: string,
    ownerAddress: string,
  ): Promise<bigint>;
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

/**
 * Snapshot of the facilitator's balance before and after a payment,
 * used to verify that the expected amount was received.
 */
export interface BalanceSnapshot {
  /** Balance before registering the sender / syncing notes */
  before: bigint;
  /** Balance after syncing notes */
  after: bigint;
  /** The difference (should equal the expected payment amount) */
  delta: bigint;
}
