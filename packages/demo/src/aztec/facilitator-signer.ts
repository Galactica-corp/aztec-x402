/**
 * Real FacilitatorAztecSigner — opens payment requests to the server's account
 * and verifies that the buyer paid them, in whichever supported token a route
 * names as its `asset`.
 *
 * Opening a request is token-specific (see `@galactica-net/x402-agent/aztec`,
 * tokens/). Verification is the same for every token: the completion log the
 * token emits when a request is paid, keyed by the request's commitment.
 *
 * For the inference-money USDC it also takes `ref` payments (a private
 * transfer under a reference, verified from the proof the buyer hands over)
 * and, given a {@link SplitMerchant}, `split` payments (one Ethereum deposit).
 */
import type {
  FacilitatorAztecSigner,
  ModeVerification,
  PaymentMode,
  PaymentNoteVerification,
  PrepareCommitmentResult,
  RefPaymentProof,
  SplitPaymentProof,
  SplitTerms,
} from "@galactica-net/x402-core";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import {
  verifyCompletion,
  type CompletionLogNode,
  type SplitMerchant,
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
    /** Takes split payments in its token, when set. */
    private readonly split?: SplitMerchant,
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

  async paymentModes(tokenAddress: string, wanted: PaymentMode[]): Promise<PaymentMode[]> {
    const token = await this.tokens.get(tokenAddress);
    return wanted.filter((mode) => {
      if (mode === "ref") return token.receivePayment !== undefined;
      if (mode === "split") return this.splitFor(tokenAddress) !== undefined;
      return true;
    });
  }

  async splitTerms(tokenAddress: string, price: bigint): Promise<SplitTerms | undefined> {
    return this.splitFor(tokenAddress)?.terms(price);
  }

  async receiveRefPayment(
    tokenAddress: string,
    proof: RefPaymentProof,
    expected: { paymentRef: string; price: bigint },
  ): Promise<ModeVerification> {
    const token = await this.tokens.get(tokenAddress);
    if (!token.receivePayment) return { isValid: false, reason: "unsupported", error: `${token.kind} takes no ref payments` };
    return token.receivePayment(proof, expected);
  }

  async verifySplitDeposit(
    tokenAddress: string,
    proof: SplitPaymentProof,
    expected: { paymentRef: string; price: bigint },
  ): Promise<ModeVerification> {
    const split = this.splitFor(tokenAddress);
    if (!split) return { isValid: false, reason: "unsupported", error: "this server takes no split payments in this token" };
    return split.verify(proof, expected);
  }

  private splitFor(tokenAddress: string): SplitMerchant | undefined {
    return this.split && this.split.token.equals(AztecAddress.fromStringUnsafe(tokenAddress)) ? this.split : undefined;
  }
}
