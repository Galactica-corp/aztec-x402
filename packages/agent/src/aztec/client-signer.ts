/**
 * Real ClientAztecSigner — pays a merchant-opened request from the buyer's
 * account, in whichever supported token the challenge names.
 *
 * Flow:
 * 1. Merchant returns { commitment, offchainMessage?, prepareTxHash }
 * 2. processOffchainMessage() registers the partial note where the token delivers it offchain
 * 3. finalizePayment() pays into the commitment
 *
 * The token-specific part of each step is in tokens/.
 */
import type { ClientAztecSigner } from "@galactica-net/x402-core";
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import type { TokenAdapter } from "./tokens/adapter.js";

interface AztecAccount {
  address: AztecAddress;
}

/** Looks a token up by address; {@link TokenRegistry} is the real one. */
export interface TokenSource {
  get(address: string): Promise<TokenAdapter>;
}

export class RealClientAztecSigner implements ClientAztecSigner {
  constructor(
    private readonly account: AztecAccount,
    private readonly tokens: TokenSource,
  ) {}

  async getAddress(): Promise<string> {
    return this.account.address.toString();
  }

  async processOffchainMessage(
    tokenAddress: string,
    offchainMessage: string,
    prepareTxHash: string,
  ): Promise<void> {
    const token = await this.tokens.get(tokenAddress);
    await token.processOffchainMessage?.(offchainMessage, prepareTxHash);
  }

  async finalizePayment(
    tokenAddress: string,
    commitment: string,
    amount: bigint,
  ): Promise<string> {
    const token = await this.tokens.get(tokenAddress);
    return token.pay(commitment, amount);
  }
}
