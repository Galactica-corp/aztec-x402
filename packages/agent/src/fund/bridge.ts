/**
 * A bridge adapter is everything the funding flow needs to know about one
 * L1 → Aztec route: which L1 transactions the user signs, how to find the
 * resulting L1→L2 message, and how the agent claims it on Aztec.
 *
 * The page and server are adapter-agnostic. v5 testnet ships the Fee Juice
 * portal adapter (the only live portal there); a stablecoin portal (e.g. the
 * USDC bridge on v6 testnet) plugs in as another adapter.
 */
import type { Session } from "../aztec/session.js";
import type { DepositRecord } from "./deposits.js";

export type Hex = `0x${string}`;

export function isHex(value: string): value is Hex {
  return /^0x[0-9a-fA-F]*$/.test(value);
}

export function toHex(value: string): Hex {
  if (!isHex(value)) throw new Error(`Not a hex string: ${value}`);
  return value;
}

export interface PreparedL1Tx {
  /** Stable id, e.g. "mint" / "approve" / "deposit". */
  id: string;
  /** What the user is about to sign, in plain words. */
  label: string;
  to: Hex;
  data: Hex;
}

export interface BridgeDescription {
  id: string;
  title: string;
  /** One line on what the agent ends up with on Aztec. */
  result: string;
  l1Token: { symbol: string; decimals: number; address: Hex };
  /** Contract the deposit is sent to, for the user to verify. */
  portal: Hex;
  defaultAmount: string;
  privacy: string;
}

export interface L1Deposit {
  messageHash: string;
  leafIndex: bigint;
  amount: bigint;
  /** The deposit's L2 recipient / secret hash, to cross-check the record. */
  recipient: string;
  secretHash: string;
}

export interface BridgeAdapter {
  describe(): Promise<BridgeDescription>;
  /** Base-unit amount for a human amount string. */
  parseAmount(amount: string): bigint;
  /** Transactions the L1 account `owner` still has to sign for this deposit. */
  prepare(owner: Hex, deposit: DepositRecord): Promise<PreparedL1Tx[]>;
  /** Read the deposit event from a mined L1 transaction. */
  readDeposit(l1TxHash: Hex): Promise<L1Deposit>;
  /** Consume the L1→L2 message on Aztec. Returns the L2 tx hash. */
  claim(session: Session, deposit: DepositRecord): Promise<string>;
  /** The agent's balance of the bridged asset on Aztec (base units). */
  l2Balance(session: Session): Promise<bigint>;
  formatAmount(amount: bigint): string;
}
