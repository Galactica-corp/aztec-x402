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
 * 2. If offchainMessage is present (v4.1.0+), calls processOffchainMessage first
 * 3. Calls finalizePayment to complete the transfer using that commitment
 * 4. Returns the sender address + txHash as the payload
 *
 * The commitment was created by the server via
 * prepare_private_balance_increase(serverAddr), so the transfer
 * is structurally bound to the server's address.
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

    // Read the server-created commitment from the prepare phase
    const commitment = paymentRequirements.extra?.commitment as
      | string
      | undefined;
    if (!commitment) {
      throw new Error(
        "missing commitment in payment requirements — server must include extra.commitment",
      );
    }

    // v4.1.0+: Process offchain message if present (registers partial note in PXE)
    const offchainMessage = paymentRequirements.extra?.offchainMessage as string | undefined;
    const prepareTxHash = paymentRequirements.extra?.prepareTxHash as string | undefined;
    if (offchainMessage && prepareTxHash && this.signer.processOffchainMessage) {
      await this.signer.processOffchainMessage(
        paymentRequirements.asset,
        offchainMessage,
        prepareTxHash,
      );
    }

    // Complete the transfer using the server's commitment
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
