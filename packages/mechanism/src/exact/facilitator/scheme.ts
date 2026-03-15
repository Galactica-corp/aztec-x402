import {
  type FacilitatorAztecSigner,
  type AztecNetwork,
  type ExactAztecPayload,
  type PrepareCommitmentResult,
  SCHEME,
  CAIP_FAMILY,
  isValidAztecAddress,
} from "@aztec-x402/core";

/**
 * Parse the generic payload record into an ExactAztecPayload.
 * No type assertions — we extract and coerce each field explicitly.
 */
function parseAztecPayload(raw: Record<string, unknown>): ExactAztecPayload {
  return {
    senderAddress: String(raw.senderAddress ?? ""),
    correlationId: String(raw.correlationId ?? ""),
    txHash: String(raw.txHash ?? ""),
    timestamp: String(raw.timestamp ?? ""),
  };
}
import type {
  SchemeNetworkFacilitator,
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
  FacilitatorContext,
  Network,
} from "../../x402-types.js";

/**
 * Facilitator-side x402 scheme for Aztec.
 *
 * The server creates commitments for its own address using the Aztec
 * token contract's prepare_private_balance_increase(serverAddr).
 * This provides structural recipient verification — the partial note is
 * bound to the server's address, so the client can only transfer TO the server.
 *
 * Flow:
 * 1. Client announces its address (prepare phase)
 * 2. Server creates commitment via preparePayment → returns commitment
 * 3. Client calls finalize_transfer_to_private_from_private with the commitment
 * 4. Server verifies tx status + note creation
 *
 * Settlement:
 * For Aztec private transfers, settlement happens at transfer time.
 * The settle method acknowledges the payment and tracks consumed txHashes.
 */
export class ExactAztecFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = SCHEME;
  readonly caipFamily = CAIP_FAMILY;

  private cachedAddresses: string[] = [];
  private consumedTxHashes = new Set<string>();
  private pendingCommitments = new Set<string>();

  constructor(
    private readonly signer: FacilitatorAztecSigner,
    private readonly networks: AztecNetwork[],
  ) {}

  getExtra(_network: Network): Record<string, unknown> | undefined {
    return undefined;
  }

  getSigners(_network: string): string[] {
    return this.cachedAddresses;
  }

  /**
   * Initialize cached addresses. Call this after construction
   * to populate the signer addresses synchronously for getSigners().
   */
  async initialize(): Promise<void> {
    this.cachedAddresses = await this.signer.getAddresses();
  }

  /**
   * Prepare a commitment for a pending payment.
   *
   * Called by the middleware during the prepare phase when the client
   * sends its address. Creates a commitment bound to the facilitator's
   * address with the client as the authorized completer.
   *
   * On v4.1.0+, the signer returns a PrepareCommitmentResult with
   * offchainMessage data. This is passed through to the client so it
   * can call offchain_receive() before finalizing.
   *
   * @param tokenAddress - The token contract address
   * @param completerAddress - The client's Aztec address
   * @returns Extra data containing commitment and optional offchainMessage
   */
  async preparePayment(
    tokenAddress: string,
    completerAddress: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.signer.prepareCommitment(
      tokenAddress,
      completerAddress,
    );

    // Handle both v4.0.x (string) and v4.1.0+ (PrepareCommitmentResult) return types
    let commitment: string;
    let offchainMessage: string | undefined;
    let prepareTxHash: string | undefined;

    if (typeof result === "string") {
      commitment = result;
    } else {
      const prepResult = result as PrepareCommitmentResult;
      commitment = prepResult.commitment;
      offchainMessage = prepResult.offchainMessage;
      prepareTxHash = prepResult.prepareTxHash;
    }

    this.pendingCommitments.add(commitment);

    const extra: Record<string, unknown> = { commitment };
    if (offchainMessage) {
      extra.offchainMessage = offchainMessage;
    }
    if (prepareTxHash) {
      extra.prepareTxHash = prepareTxHash;
    }
    return extra;
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    _context?: FacilitatorContext,
  ): Promise<VerifyResponse> {
    const aztecPayload = parseAztecPayload(payload.payload);

    // 1. Reject replayed payments
    if (aztecPayload.txHash && this.consumedTxHashes.has(aztecPayload.txHash)) {
      return {
        isValid: false,
        invalidReason: "payment already used",
        invalidMessage: "This payment has already been consumed.",
        payer: aztecPayload.senderAddress,
      };
    }

    // 2. Validate payload structure
    const validationError = this.validatePayload(aztecPayload);
    if (validationError) {
      return {
        isValid: false,
        invalidReason: validationError,
        invalidMessage: `Payment payload validation failed: ${validationError}`,
      };
    }

    // 3. Validate that the commitment was issued by this facilitator
    const commitment = requirements.extra?.commitment as string | undefined;
    if (!commitment || !this.pendingCommitments.has(commitment)) {
      return {
        isValid: false,
        invalidReason: "invalid or missing commitment",
        invalidMessage: "Payment commitment was not issued by this facilitator.",
        payer: aztecPayload.senderAddress,
      };
    }

    try {
      // 4. Verify the finalized transfer via the facilitator's node
      const verification = await this.signer.verifyPayment(
        aztecPayload.txHash,
        requirements.asset,
        BigInt(requirements.amount),
      );

      if (!verification.isValid) {
        return {
          isValid: false,
          invalidReason: verification.error ?? "payment verification failed",
          invalidMessage: `Payment verification failed: ${verification.error ?? "unknown error"}`,
          payer: aztecPayload.senderAddress,
        };
      }

      return {
        isValid: true,
        payer: aztecPayload.senderAddress,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isValid: false,
        invalidReason: `verification error: ${message}`,
        invalidMessage: `Failed to verify payment: ${message}`,
      };
    }
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    _context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    const aztecPayload = parseAztecPayload(payload.payload);

    // Consume the commitment and txHash
    const commitment = requirements.extra?.commitment as string | undefined;
    if (commitment) {
      this.pendingCommitments.delete(commitment);
    }
    if (aztecPayload.txHash) {
      this.consumedTxHashes.add(aztecPayload.txHash);
    }

    return {
      success: true,
      payer: aztecPayload.senderAddress,
      transaction: aztecPayload.txHash,
      network: requirements.network,
    };
  }

  private validatePayload(payload: ExactAztecPayload): string | undefined {
    if (!payload.senderAddress) {
      return "missing senderAddress";
    }

    if (!isValidAztecAddress(payload.senderAddress)) {
      return "invalid sender address format";
    }

    if (!payload.correlationId) {
      return "missing correlationId";
    }

    if (!payload.txHash) {
      return "missing txHash";
    }

    return undefined;
  }
}
