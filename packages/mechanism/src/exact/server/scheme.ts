import {
  type AztecServerConfig,
  SCHEME,
  parsePrice as corePriceParser,
} from "@aztech-x402/core";
import type {
  SchemeNetworkServer,
  Price,
  AssetAmount,
  PaymentRequirements,
  SupportedKind,
  Network,
} from "../../x402-types.js";

/**
 * Server-side x402 scheme for Aztec.
 *
 * Responsible for:
 * 1. Parsing human-readable prices into token amounts
 * 2. Enhancing payment requirements with Aztec-specific data
 */
export class ExactAztecServerScheme implements SchemeNetworkServer {
  readonly scheme = SCHEME;

  private readonly tokenDecimals: Record<string, number>;

  constructor(config?: AztecServerConfig) {
    this.tokenDecimals = config?.tokenDecimals ?? {};
  }

  async parsePrice(price: Price, _network: Network): Promise<AssetAmount> {
    // If already an AssetAmount, pass through
    if (typeof price === "object" && "asset" in price && "amount" in price) {
      return price;
    }

    // Parse human-readable price to smallest units
    const amount = corePriceParser(price);

    return {
      asset: "",
      amount: amount.toString(),
    };
  }

  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    _supportedKind: SupportedKind,
    _facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    // No enhancement needed for Aztec — unlike SVM which needs feePayer
    return paymentRequirements;
  }
}
