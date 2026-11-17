/**
 * The inference-money USDC: aztec-standards' Token plus a merchant list.
 *
 * What differs from AIP-20 (see inference-money's docs/integration.md):
 * - A user may only pay a listed merchant, so the server must be one and the
 *   buyer checks `payTo` before asking for a request.
 * - Each restricted call proves one side a merchant. The SDK attaches the hint
 *   for it from a merchant list synced whole, so the node does not learn whom
 *   this wallet transacts with.
 * - A request takes one payment, refused a second time only on chain. The SDK's
 *   `PaymentGate` refuses it before proving; the buyer's wallet must be built
 *   through that gate ({@link createPaymentGate}).
 *
 * This module loads the SDK and its contract artifacts; registry.ts imports it
 * only once a token of this kind is used.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { Contract } from "@aztec-labs/aztec.js/contracts";
import { Fr } from "@aztec-labs/aztec.js/fields";
import type { AztecNode } from "@aztec-labs/aztec.js/node";
import {
  PaymentGate,
  PaymentRefusedError,
  memoryPaymentStore,
  merchantStatus,
  openRequest,
  payRequest,
  syncMerchantList,
  tokenArtifact,
  tokenRefusalOf,
  type MerchantList,
  type PaymentStore,
} from "@galactica-net/inference-money-core";
import type { PrepareCommitmentResult } from "@galactica-net/x402-core";
import { unwrapAztecSdkResult } from "@galactica-net/x402-core";
import { TokenRefusedError } from "../../errors.js";
import type { TokenAdapter, TokenContext } from "./adapter.js";

export { tokenArtifact as inferenceTokenArtifact };

/** The gate a buyer's wallet is built through; `store` must outlive the process for a CLI (payment-store.ts). */
export function createPaymentGate(node: AztecNode, store: PaymentStore = memoryPaymentStore()): PaymentGate {
  return new PaymentGate(node, store);
}

/** Turn the SDK's and the contract's refusals into errors the CLI reports by code. */
export function asTokenError(error: unknown): unknown {
  if (error instanceof PaymentRefusedError) {
    return new TokenRefusedError(error.message, "payment_refused", { reason: error.reason, txHash: error.txHash });
  }
  const rule = tokenRefusalOf(error);
  if (rule) {
    return new TokenRefusedError(error instanceof Error ? error.message : String(error), "token_refused", { rule });
  }
  return error;
}

export class InferenceMoneyToken implements TokenAdapter {
  readonly kind = "inference-money";

  constructor(
    private readonly ctx: TokenContext,
    readonly address: AztecAddress,
  ) {}

  /** Synced before every use: sides are judged at the list's block, so a kept list goes stale. */
  private readonly syncList = (): Promise<MerchantList> => syncMerchantList(this.ctx.node, this.address);

  private get listOptions() {
    return { resync: this.syncList, fee: this.ctx.fee };
  }

  async assertCanSell(): Promise<void> {
    const { merchant } = merchantStatus(await this.syncList(), this.ctx.account);
    if (!merchant) {
      throw new TokenRefusedError(
        `${this.ctx.account} is not a listed merchant of token ${this.address}, so it cannot open payment requests in it.`,
        "merchant_not_listed",
      );
    }
  }

  async openRequest(completer: AztecAddress): Promise<PrepareCommitmentResult> {
    const merchant = this.ctx.account;
    try {
      const { commitment, txHash } = await openRequest(
        this.ctx.wallet,
        this.ctx.node,
        this.address,
        { from: merchant, to: merchant, completer },
        { list: await this.syncList(), ...this.listOptions },
      );
      return { commitment: commitment.toString(), prepareTxHash: txHash.toString() };
    } catch (error) {
      throw asTokenError(error);
    }
  }

  async preflight(payTo: AztecAddress): Promise<void> {
    const list = await this.syncList();
    // A merchant may pay anyone; a user only a merchant.
    if (!merchantStatus(list, payTo).merchant && !merchantStatus(list, this.ctx.account).merchant) {
      throw new TokenRefusedError(
        `${payTo} is not a listed merchant of token ${this.address}; this token only pays listed merchants.`,
        "merchant_not_listed",
      );
    }
  }

  async pay(commitment: string, amount: bigint): Promise<string> {
    const gate = this.ctx.paymentGate;
    if (!gate) {
      throw new Error("Paying in the inference-money token needs a wallet built through createPaymentGate().");
    }
    try {
      const txHash = await payRequest(
        gate,
        this.ctx.wallet,
        this.address,
        { from: this.ctx.account, commitment: Fr.fromString(commitment), amount, kind: "private" },
        { list: await this.syncList(), ...this.listOptions },
      );
      return txHash.toString();
    } catch (error) {
      throw asTokenError(error);
    }
  }

  async privateBalance(): Promise<bigint> {
    const owner = this.ctx.account;
    const balance = Contract.at(this.address, tokenArtifact, this.ctx.wallet).methods.balance_of_private;
    if (!balance) throw new Error("The token artifact has no balance_of_private.");
    const value = unwrapAztecSdkResult(await balance(owner).simulate({ from: owner }));
    return typeof value === "bigint" ? value : BigInt(String(value));
  }
}
