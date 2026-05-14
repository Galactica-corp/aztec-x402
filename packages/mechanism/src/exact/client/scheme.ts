import {
  type ClientAztecSigner,
  SCHEME,
  generateCorrelationId,
  parseAztecPaymentExtra,
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
 * initialize_transfer_commitment(serverAddr), so the transfer
 * is structurally bound to the server's address.
 */
export class ExactAztecClientScheme implements SchemeNetworkClient {
  readonly scheme = SCHEME;

  constructor(private readonly signer: ClientAztecSigner) {}

  async getSenderAddress(): Promise<string> {
    return this.signer.getAddress();
  }

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    _context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const senderAddress = await this.signer.getAddress();
    const correlationId = generateCorrelationId();
    const extra = parseAztecPaymentExtra(paymentRequirements.extra);

    // Read the server-created commitment from the prepare phase
    const commitment = extra.commitment;
    if (!commitment) {
      throw new Error(
        "missing commitment in payment requirements — server must include extra.commitment",
      );
    }

    // v4.1.0+: Process offchain message if present (registers partial note in PXE)
    const offchainMessage = extra.offchainMessage;
    const prepareTxHash = extra.prepareTxHash;
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
