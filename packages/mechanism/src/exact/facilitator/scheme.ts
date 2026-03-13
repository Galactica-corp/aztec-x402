import {
  type FacilitatorAztecSigner,
  type AztecNetwork,
  type ExactAztecPayload,
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
 * Uses commitment-based verification:
 * 1. preparePayment: generates a commitment via prepare_private_balance_increase
 * 2. Commitment is included in 402 response (PaymentRequirements.extra)
 * 3. Client finalizes transfer using commitment
 * 4. verify: checks tx status + confirms payment via facilitator's PXE
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
    // Commitment generation is async — handled by preparePayment instead
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
   * Called by the middleware when generating a 402 response. The returned
   * commitment is included in PaymentRequirements.extra.commitment so the
   * client can use it to finalize the transfer.
   *
   * @param tokenAddress - The token contract address
   * @returns Extra data to merge into PaymentRequirements.extra
   */
  async preparePayment(
    tokenAddress: string,
  ): Promise<Record<string, unknown>> {
    const commitment = await this.signer.prepareCommitment(tokenAddress);
    this.pendingCommitments.add(commitment);
    return { commitment };
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
      // 4. Verify the finalized transfer via the facilitator's PXE
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
