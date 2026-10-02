/**
 * A bridge adapter is everything the funding flow needs to know about one
 * L1 → Aztec route: the L1 transactions the user signs (as a funding plan),
 * how to find the resulting deposit on L1, and how the agent claims it.
 *
 * The plan is plain data. The funding page executes it in the user's browser
 * — served locally by the CLI, or from the hosted copy of the skill's page
 * with the plan in the URL fragment — so neither the page nor its host ever
 * needs a connection back to the agent. The CLI finds the deposit by watching
 * L1 logs. v5 testnet ships the Fee Juice portal adapter; a stablecoin portal
 * (e.g. the USDC bridge on v6 testnet) plugs in as another adapter.
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

/** Placeholder in step calldata for the user's L1 address, as a 32-byte ABI word. */
export const OWNER_WORD = "{owner}";

/**
 * One L1 transaction for the user to sign. `data` may contain OWNER_WORD;
 * the page substitutes the connected account (left-padded to 32 bytes).
 */
export interface PlanStep {
  id: string;
  /** What the user is about to sign, in plain words. */
  label: string;
  to: Hex;
  data: string;
  /** Skip when `eth_call(to, data)` returns a uint256 ≥ `gte` (decimal base units). */
  skipIf?: { to: Hex; data: string; gte: string };
  /** Re-run the step until `skipIf` holds (e.g. a faucet that mints a fixed amount per call). */
  repeat?: boolean;
}

export interface FundingPlan {
  v: 1;
  network: string;
  l1ChainId: number;
  l1ChainName: string;
  l1ExplorerUrl?: string;
  /** Agent's Aztec address that receives the deposit. */
  agent: string;
  /** Human-readable amount and token, e.g. "100" FEE. */
  amount: string;
  token: { symbol: string; decimals: number; address: Hex };
  portal: Hex;
  title: string;
  /** One line on what the agent ends up with on Aztec. */
  result: string;
  privacy: string;
  steps: PlanStep[];
}

export interface BridgeDescription {
  id: string;
  title: string;
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
  formatAmount(amount: bigint): string;
  /** The L1 steps for this deposit; owner-independent, so it can travel in a URL. */
  steps(deposit: DepositRecord): PlanStep[];
  /** Current L1 block, recorded so a later search for the deposit knows where to start. */
  l1BlockNumber(): Promise<bigint>;
  /** Find the L1 transaction that made this deposit, searching from `fromBlock`. */
  findDeposit(deposit: DepositRecord, fromBlock: bigint): Promise<Hex | undefined>;
  /** Read the deposit event from an L1 transaction, waiting up to `timeoutMs` for it to be mined. */
  readDeposit(l1TxHash: Hex, timeoutMs?: number): Promise<L1Deposit>;
  /** Consume the L1→L2 message on Aztec. Returns the L2 tx hash. */
  claim(session: Session, deposit: DepositRecord): Promise<string>;
  /** The agent's balance of the bridged asset on Aztec (base units). */
  l2Balance(session: Session): Promise<bigint>;
}
