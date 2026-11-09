import {
  type ClientAztecSigner,
  SCHEME,
  SplitTermsSchema,
  generateCorrelationId,
  parseAztecPaymentExtra,
} from "@galactica-net/x402-core";
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

  /**
   * The first entry this signer can pay: `ref` needs `payPrivate`, `split`
   * needs `paySplit`, the commitment flow (no mode) is always payable.
   */
  selectRequirement(accepts: PaymentRequirements[]): PaymentRequirements | undefined {
    return accepts.find((a) => {
      if (a.scheme !== this.scheme) return false;
      const mode = parseAztecPaymentExtra(a.extra).mode;
      if (mode === "ref") return this.signer.payPrivate !== undefined;
      if (mode === "split") return this.signer.paySplit !== undefined;
      return true;
    });
  }

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    _context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const mode = parseAztecPaymentExtra(paymentRequirements.extra).mode;
    if (mode === "ref") return this.payRef(x402Version, paymentRequirements);
    if (mode === "split") return this.paySplit(x402Version, paymentRequirements);

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

  private async payRef(x402Version: number, req: PaymentRequirements): Promise<PaymentPayloadResult> {
    const { paymentRef } = parseAztecPaymentExtra(req.extra);
    if (!paymentRef) throw new Error("missing paymentRef in a ref payment's requirements");
    if (!this.signer.payPrivate) throw new Error("this signer cannot make ref payments");
    const proof = await this.signer.payPrivate(req.asset, req.payTo, BigInt(req.amount), paymentRef);
    return { x402Version, payload: { mode: "ref", ...proof } };
  }

  private async paySplit(x402Version: number, req: PaymentRequirements): Promise<PaymentPayloadResult> {
    const extra = parseAztecPaymentExtra(req.extra);
    if (!extra.paymentRef) throw new Error("missing paymentRef in a split payment's requirements");
    if (!this.signer.paySplit) throw new Error("this signer cannot make split payments");
    const terms = SplitTermsSchema.parse(extra);
    if (terms.price !== req.amount || terms.merchant.toLowerCase() !== req.payTo.toLowerCase()) {
      throw new Error("split terms disagree with the payment's amount or recipient");
    }
    const proof = await this.signer.paySplit(req.asset, { ...terms, paymentRef: extra.paymentRef });
    return { x402Version, payload: { mode: "split", ...proof } };
  }
}
