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
 * When the client receives a 402 response with a commitment:
 * 1. Reads the commitment from PaymentRequirements.extra.commitment
 * 2. Calls finalizePayment to complete the transfer using that commitment
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

    // Read the commitment from the 402 response
    const commitment = paymentRequirements.extra?.commitment as
      | string
      | undefined;
    if (!commitment) {
      throw new Error(
        "missing commitment in payment requirements — server must include extra.commitment",
      );
    }

    // Finalize the transfer using the facilitator's commitment
    const txHash = await this.signer.finalizePayment(
      paymentRequirements.asset,
      commitment,
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
