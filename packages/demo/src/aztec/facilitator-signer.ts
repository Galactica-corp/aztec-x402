/**
 * Real FacilitatorAztecSigner — opens payment requests to the server's account
 * and verifies that the buyer paid them, in whichever supported token a route
 * names as its `asset`.
 *
 * Opening a request is token-specific (see `@galactica-net/x402-agent/aztec`,
 * tokens/). Verification is the same for every token: the completion log the
 * token emits when a request is paid, keyed by the request's commitment.
 */
import type {
  FacilitatorAztecSigner,
  PaymentNoteVerification,
  PrepareCommitmentResult,
} from "@galactica-net/x402-core";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import {
  verifyCompletion,
  type CompletionLogNode,
  type TokenSource,
} from "@galactica-net/x402-agent/aztec";

interface AztecAccount {
  address: AztecAddress;
}

export class RealFacilitatorAztecSigner implements FacilitatorAztecSigner {
  constructor(
    private readonly account: AztecAccount,
    private readonly node: CompletionLogNode,
    private readonly tokens: TokenSource,
  ) {}

  async getAddresses(): Promise<string[]> {
    return [this.account.address.toString()];
  }

  /**
   * Throws unless this server can charge in `tokenAddress` right now: the
   * contract is a supported token and its rules let this account sell (for
   * the inference-money token: the account is a listed merchant). Call it at
   * start for every route's asset, so a misconfigured server fails then and
   * not at a buyer's first prepare.
   */
  async assertCanSell(tokenAddress: string): Promise<void> {
    await (await this.tokens.get(tokenAddress)).assertCanSell();
  }

  async prepareCommitment(
    tokenAddress: string,
    completerAddress: string,
  ): Promise<PrepareCommitmentResult> {
    const token = await this.tokens.get(tokenAddress);
    return token.openRequest(AztecAddress.fromStringUnsafe(completerAddress));
  }

  async verifyPayment(
    txHash: string,
    tokenAddress: string,
    requiredAmount: bigint,
    commitment?: string,
  ): Promise<PaymentNoteVerification> {
    try {
      // Only tokens this server sells in are verified.
      await this.tokens.get(tokenAddress);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isValid: false, amountFound: 0n, error: `wrong token: ${message}` };
    }
    return verifyCompletion(this.node, txHash, tokenAddress, requiredAmount, commitment);
  }
}
