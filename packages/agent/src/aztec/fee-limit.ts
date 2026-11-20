/**
 * Whether an account that pays its own fees can afford a transaction.
 *
 * The node refuses a tx whose fee limit (gas limits × max fee per gas) exceeds
 * its fee payer's Fee Juice, even when the fee actually charged would fit: the
 * wallet pads the base fee by 1.5× and the estimated gas by 1.1×, so an exit
 * that costs 1.9 FEE declares about 3.1. A refusal after the tx was handed to
 * the node reads as "dropped", which bridge exits must treat as possibly still
 * landing, so this is checked before proving instead.
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import type { AztecNode } from "@aztec-labs/aztec.js/node";
import { getFeeJuiceBalance } from "@aztec-labs/aztec.js/utils";
import { formatAmount } from "@galactica-net/x402-core";
import { CliError } from "../errors.js";

/** Fee Juice has 18 decimals (fee-juice.ts, which this module cannot import: it depends on the wallet). */
const FEE_JUICE_DECIMALS = 18;

/**
 * L2 gas a typical transaction of this package declares, padding included: a payment or an exit uses about
 * 0.75–1M L2 gas on mainnet (late 2026), and the wallet adds 10%.
 */
export const TYPICAL_TX_L2_GAS = 1_100_000n;

/** The wallet's padding on the minimum fee per gas (BaseWallet's `minFeePadding`, 0.5). */
const MIN_FEE_PADDING_PERCENT = 150n;

/** Raised before proving when the fee payer's Fee Juice is below the tx's fee limit; nothing was sent. */
export class InsufficientFeeJuiceError extends CliError {
  constructor(
    readonly address: string,
    readonly balance: bigint,
    readonly needed: bigint,
  ) {
    super(
      `${address} pays its own fees and holds ${formatFeeJuice(balance)} Fee Juice, less than the ${formatFeeJuice(needed)} ` +
        "this transaction may charge (its fee limit: the node refuses a tx its payer cannot cover in full). Nothing was " +
        "sent. Bridge more Fee Juice to the account (`aztec-x402 fund`) and try again.",
      "insufficient_fee_juice",
      { address, balance: formatFeeJuice(balance), needed: formatFeeJuice(needed), txSubmitted: false },
    );
    this.name = "InsufficientFeeJuiceError";
  }
}

/** Fee Juice in whole tokens, to four decimals (rounded down). */
export function formatFeeJuice(amount: bigint): string {
  const [whole, frac = ""] = formatAmount(amount, FEE_JUICE_DECIMALS).split(".");
  const short = frac.slice(0, 4).replace(/0+$/, "");
  return short ? `${whole}.${short}` : (whole ?? "0");
}

/** Refuses when `balance` cannot cover `feeLimit`. */
export function assertCoversFeeLimit(address: AztecAddress | string, balance: bigint, feeLimit: bigint): void {
  if (balance < feeLimit) throw new InsufficientFeeJuiceError(address.toString(), balance, feeLimit);
}

/** The fee limit a typical tx declares at the node's current minimum fees, as the wallet pads them. */
export async function typicalTxFeeLimit(node: Pick<AztecNode, "getCurrentMinFees">, l2Gas = TYPICAL_TX_L2_GAS): Promise<bigint> {
  const fees = await node.getCurrentMinFees();
  return (fees.feePerL2Gas * MIN_FEE_PADDING_PERCENT * l2Gas) / 100n;
}

/** The account's Fee Juice and how many typical txs it covers. */
export async function feeJuiceHeadroom(node: AztecNode, address: AztecAddress): Promise<{ balance: bigint; txFeeLimit: bigint; txs: bigint }> {
  const [balance, txFeeLimit] = await Promise.all([getFeeJuiceBalance(address, node), typicalTxFeeLimit(node)]);
  return { balance, txFeeLimit, txs: txFeeLimit === 0n ? 0n : balance / txFeeLimit };
}
