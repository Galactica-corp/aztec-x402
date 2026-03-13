import {
  type ClientAztecSigner,
  SCHEME,
  generateCorrelationId,
} from "@aztec-x402/core";
import type {
  SchemeNetworkClient,
  PaymentRequirements,
  PaymentPayloadResult,
  PaymentPayloadContext,
} from "../../x402-types.js";

/**
 * Client-side x402 scheme for Aztec.
 *
 * When the client receives a 402 response:
 * 1. Reads payTo from PaymentRequirements
 * 2. Calls finalizePayment to transfer tokens directly to payTo
 * 3. Returns the sender address + txHash as the payload
 */
export class ExactAztecClientScheme implements SchemeNetworkClient {
  readonly scheme = SCHEME;

  constructor(private readonly signer: ClientAztecSigner) {}

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    _context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const senderAddress = await this.signer.getAddress();
    const correlationId = generateCorrelationId();

    // Transfer tokens directly to the facilitator's payTo address
    const txHash = await this.signer.finalizePayment(
      paymentRequirements.asset,
      paymentRequirements.payTo,
      BigInt(paymentRequirements.amount),
    );

    const payload: Record<string, unknown> = {
      senderAddress,
      correlationId,
      txHash,
      timestamp: new Date().toISOString(),
    };

    return {
      x402Version,
      payload,
    };
  }
}
