/**
 * Token kinds.
 *
 * A payment names its token only by address (the route's `asset`). Everything
 * that differs between tokens sits behind {@link TokenAdapter}: how the
 * merchant opens a payment request, how the buyer pays it, and which rules
 * either side must meet first. The HTTP flow and the completion-log check
 * (completion-log.ts) are the same for every kind.
 *
 * To add a kind: implement {@link TokenAdapter} and teach `identifyToken`
 * (registry.ts) its contract class.
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import type { FeePaymentMethod } from "@aztec-labs/aztec.js/fee";
import type { AztecNode } from "@aztec-labs/aztec.js/node";
import type { PaymentGate } from "@galactica-net/inference-money-core";
import type { PrepareCommitmentResult } from "@galactica-net/x402-core";
import type { PXEWallet } from "../pxe-wallet.js";

/**
 * - `aip20`: the upstream aztec-standards Token; anyone may pay anyone.
 * - `inference-money`: the bridged USDC of inference-money; a user may only pay a listed merchant.
 */
export type TokenKind = "aip20" | "inference-money";

/** The wallet a token is used from: the merchant's when selling, the buyer's when paying. */
export interface TokenContext {
  node: AztecNode;
  wallet: PXEWallet;
  /** The account that receives (merchant) or pays (buyer). */
  account: AztecAddress;
  fee?: { paymentMethod: FeePaymentMethod };
  /** Buyer side of `inference-money`: the gate `wallet` was built through (see inference.ts). */
  paymentGate?: PaymentGate;
}

export interface TokenAdapter {
  readonly kind: TokenKind;
  readonly address: AztecAddress;

  /** Merchant: throws unless this account can charge in the token right now. */
  assertCanSell(): Promise<void>;

  /** Merchant: open a payment request to this account that only `completer` can pay. */
  openRequest(completer: AztecAddress): Promise<PrepareCommitmentResult>;

  /** Buyer: throws when the token's rules would refuse a payment to `payTo`, before the merchant prepares. */
  preflight(payTo: AztecAddress): Promise<void>;

  /** Buyer: register a partial note the merchant delivered offchain, where the token supports it. */
  processOffchainMessage?(offchainMessage: string, prepareTxHash: string): Promise<void>;

  /** Buyer: pay `amount` into the request; returns the tx hash once checkpointed. */
  pay(commitment: string, amount: bigint): Promise<string>;

  /** This account's private balance in base units. */
  privateBalance(): Promise<bigint>;
}
