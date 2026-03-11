import {
  type FacilitatorAztecSigner,
  type AztecNetwork,
  type ExactAztecPayload,
  SCHEME,
  CAIP_FAMILY,
  isValidAztecAddress,
} from "@aztech-x402/core";

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
 * Verification flow:
 * 1. Validate the payload structure (sender address, correlation ID, txHash)
 * 2. Check txHash against consumed set (anti-replay)
 * 3. Register the sender in PXE so we can discover their notes
 * 4. Use verifyPaymentNotes to confirm the specific tx created payment notes
 *    for the facilitator with at least the required amount
 *
 * Settlement:
 * For Aztec private transfers, settlement happens at transfer time
 * (the client already submitted the on-chain transaction). The settle
 * method simply acknowledges the payment.
 */
export class ExactAztecFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = SCHEME;
  readonly caipFamily = CAIP_FAMILY;

  private cachedAddresses: string[] = [];
  private consumedTxHashes = new Set<string>();

  constructor(
    private readonly signer: FacilitatorAztecSigner,
    private readonly networks: AztecNetwork[],
  ) {}

  getExtra(_network: Network): Record<string, unknown> | undefined {
    // No extra data needed for Aztec — unlike SVM which needs feePayer
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

    try {
      // 3. Register sender so PXE discovers their notes
      await this.signer.registerSender(aztecPayload.senderAddress);

      // 4. Verify this specific transaction created payment notes for the facilitator
      const verification = await this.signer.verifyPaymentNotes(
        aztecPayload.txHash,
        requirements.asset,
        requirements.payTo,
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

    // For Aztec, the client has already submitted the private transfer.
    // Settlement is just acknowledgment — the funds are already in our notes.
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
