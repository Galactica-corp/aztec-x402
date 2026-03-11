import {
  type ClientAztecSigner,
  SCHEME,
  generateCorrelationId,
} from "@aztech-x402/core";
import type {
  SchemeNetworkClient,
  PaymentRequirements,
  PaymentPayloadResult,
  PaymentPayloadContext,
} from "../../x402-types.js";

/**
 * Client-side x402 scheme for Aztec.
 *
 * When the client receives a 402 response, it:
 * 1. Executes a transfer_private_to_private on the token contract
 * 2. Returns the sender address + correlation ID as the payload
 *
 * The server then uses PXE note discovery to verify payment receipt.
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

    // Execute the private transfer
    const txHash = await this.signer.transferPrivateToPrivate(
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
