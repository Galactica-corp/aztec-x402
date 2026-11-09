/**
 * Paying a merchant from Ethereum in one step (split deposit), for an agent
 * that holds no L1 key: the user signs the deposit in their own browser
 * wallet on the funding page, the agent finds it on L1 and hands the merchant
 * its proof, and later collects the change into its Aztec account.
 *
 * The deposit is built by the inference-money SDK from the agent's own bridge
 * manifest; the merchant's split terms are checked against it, never trusted.
 * Each record holds the draft, whose salts are the only way to collect the
 * change: the file is 0600 and never leaves the agent.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import {
  DENOMINATIONS,
  LOG_SCAN_CHUNK,
  PERMIT2_DEPOSIT_ROUTER_ABI,
  decodeClaimTicket,
  decodeDepositDraft,
  encodeTicket,
  parseManifest,
  splitProofOf,
  ticketFromReceiptLogs,
  type BridgeManifest,
  type ClaimTicket,
  type DepositDraft,
} from "@galactica-net/inference-money-core";
import { TESTNET_MANIFEST } from "@galactica-net/inference-money-core/deployments";
import type { PaymentRequirements } from "@galactica-net/x402-mechanism";
import type { SplitPaymentProof, SplitTerms } from "@galactica-net/x402-core";
import { createPublicClient, encodeFunctionData, erc20Abi, http, parseEventLogs, type Log } from "viem";
import type { NetworkConfig } from "../networks.js";
import { CliError, UsageError } from "../errors.js";
import { OWNER_WORD, type FundingPlan, type Hex, type PlanStep } from "./bridge.js";

/** Placeholder in step calldata for the user's 65-byte signature, filled by the page from the `sign` step. */
export const SIGNATURE_WORD = "{signature}";
/** Encoded in place of the signature, then swapped for SIGNATURE_WORD. */
const SIGNATURE_SENTINEL: Hex = `0x${"5a".repeat(65)}`;
const OWNER_SENTINEL: Hex = "0x00000000000000000000000000000000000a11ce";

export type SplitStatus = "awaiting_deposit" | "deposited" | "served" | "not_served" | "change_collected" | "change_returned";

export interface SplitRecord {
  id: string;
  createdAt: string;
  url: string;
  /** The request to replay with the proof. */
  request: { method: string; headers: Record<string, string>; body?: string };
  /** The accepted `split` entry of the 402. */
  accepted: PaymentRequirements;
  price: string;
  amount: string;
  /** encodeTicket("draft", …): holds the change's salt. */
  draft: string;
  /** L1 block to search for the deposit from. */
  l1FromBlock: string;
  l1TxHash?: string;
  /** encodeTicket("claim", …) once the deposit is mined. */
  ticket?: string;
  status: SplitStatus;
  changeTxHash?: string;
  error?: string;
}

const recordsPath = (dataDir: string) => join(dataDir, "split-payments.json");

export function readSplitRecords(dataDir: string): SplitRecord[] {
  const path = recordsPath(dataDir);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : [];
}

export function saveSplitRecord(dataDir: string, record: SplitRecord): void {
  const all = readSplitRecords(dataDir).filter((r) => r.id !== record.id);
  all.push(record);
  writeFileSync(`${recordsPath(dataDir)}.tmp`, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  // Write-then-rename: a crash never leaves the only copy of a salt half-written.
  renameSync(`${recordsPath(dataDir)}.tmp`, recordsPath(dataDir));
}

export function splitRecord(dataDir: string, id: string): SplitRecord {
  const record = readSplitRecords(dataDir).find((r) => r.id === id);
  if (!record) throw new UsageError(`No split payment with id ${id}.`, "not_found");
  return record;
}

export const draftOf = (r: SplitRecord): DepositDraft => decodeDepositDraft(r.draft);
export const ticketOf = (r: SplitRecord): ClaimTicket | undefined => (r.ticket ? decodeClaimTicket(r.ticket) : undefined);

/**
 * The bridge this agent deposits through: the SDK's testnet deployment, or on
 * another network the manifest file named by AZTEC_X402_BRIDGE_MANIFEST.
 */
export function bridgeManifestFor(network: NetworkConfig): BridgeManifest | undefined {
  const path = process.env.AZTEC_X402_BRIDGE_MANIFEST;
  if (path) return parseManifest(JSON.parse(readFileSync(path, "utf-8")));
  return network.name === "testnet" ? parseManifest(TESTNET_MANIFEST) : undefined;
}

/** Refuses split terms for another bridge than the agent's own, or another payment than the 402's. */
export function assertSplitTerms(terms: SplitTerms, m: BridgeManifest, accepted: PaymentRequirements): void {
  if (terms.chainId !== m.l1.chainId || terms.portal.toLowerCase() !== m.l1.portal.toLowerCase()) {
    throw new CliError(
      `The merchant's split terms name chain ${terms.chainId} portal ${terms.portal}, not this agent's bridge (${m.l1.chainId}, ${m.l1.portal}).`,
      "split_terms_mismatch",
    );
  }
  if (terms.price !== accepted.amount || terms.merchant.toLowerCase() !== accepted.payTo.toLowerCase()) {
    throw new CliError("The merchant's split terms disagree with the payment's amount or recipient.", "split_terms_mismatch");
  }
}

/** The deposit amount: `wanted` (base units) if the merchant offers it, else the smallest offered round amount ≥ the price. */
export function chooseDeposit(terms: SplitTerms, wanted?: bigint): bigint {
  const offered = terms.denominations
    .map(BigInt)
    .filter((d) => DENOMINATIONS.includes(d) && d >= BigInt(terms.price))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (wanted !== undefined) {
    if (!offered.includes(wanted)) {
      throw new UsageError(`A deposit of ${wanted} base units is not offered; choose one of ${offered.join(", ")}.`, "bad_deposit_amount");
    }
    return wanted;
  }
  const smallest = offered[0];
  if (smallest === undefined) throw new CliError("The merchant offers no deposit amount this agent can build.", "no_deposit_amount");
  return smallest;
}

const word = (value: bigint) => value.toString(16).padStart(64, "0");

/** EIP-712 typed data as `eth_signTypedData_v4` takes it: the domain's own type listed, numbers as decimal strings. */
export function typedDataForWallet(draft: DepositDraft): unknown {
  const td = draft.typedData;
  const domainType = [
    ...(td.domain.name !== undefined ? [{ name: "name", type: "string" }] : []),
    ...(td.domain.chainId !== undefined ? [{ name: "chainId", type: "uint256" }] : []),
    ...(td.domain.verifyingContract !== undefined ? [{ name: "verifyingContract", type: "address" }] : []),
  ];
  return JSON.parse(
    JSON.stringify({ ...td, types: { EIP712Domain: domainType, ...td.types } }, (_k, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  );
}

/**
 * The funding page's steps: approve Permit2 once (skipped when the allowance
 * already covers the deposit), sign the deposit permit, send the deposit to
 * the router with that signature.
 */
export function splitSteps(draft: DepositDraft, m: BridgeManifest): PlanStep[] {
  const amount = draft.intent.amount;
  const message = draft.typedData.message;
  const deposit = encodeFunctionData({
    abi: PERMIT2_DEPOSIT_ROUTER_ABI,
    functionName: "deposit",
    args: [
      message.permitted.amount,
      draft.witness.aztecRecipient,
      draft.witness.secretHash,
      draft.witness.isPrivate,
      message.nonce,
      message.deadline,
      SIGNATURE_SENTINEL,
    ],
  });
  const sentinel = SIGNATURE_SENTINEL.slice(2);
  if (deposit.split(sentinel).length !== 2) throw new Error("could not place the signature in the deposit calldata");
  const allowance = encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [OWNER_SENTINEL, m.l1.permit2] });
  const ownerWord = word(BigInt(OWNER_SENTINEL));
  return [
    {
      id: "approve",
      label: `Allow Permit2 to move your USDC (once per wallet)`,
      to: m.l1.usdc,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [m.l1.permit2, 2n ** 256n - 1n] }),
      skipIf: { to: m.l1.usdc, data: allowance.replace(ownerWord, OWNER_WORD), gte: amount.toString() },
    },
    {
      id: "permit",
      kind: "sign",
      label: "Sign the deposit permit (no transaction)",
      to: m.l1.permit2,
      data: "0x",
      typedData: typedDataForWallet(draft),
    },
    {
      id: "deposit",
      label: "Send the deposit",
      to: m.l1.router,
      data: deposit.replace(sentinel, SIGNATURE_WORD),
    },
  ];
}

export function buildSplitPlan(network: NetworkConfig, m: BridgeManifest, draft: DepositDraft, agent: string, merchant: string, price: string, formatUsdc: (v: bigint) => string): FundingPlan {
  const amount = draft.intent.amount;
  return {
    v: 1,
    kind: "split",
    network: network.name,
    l1ChainId: m.l1.chainId,
    l1ChainName: network.l1ChainName,
    l1ExplorerUrl: network.l1ExplorerUrl,
    agent,
    amount: formatUsdc(amount),
    token: { symbol: "USDC", decimals: 6, address: m.l1.usdc },
    portal: m.l1.portal,
    title: "Pay a merchant from Ethereum",
    result: `${formatUsdc(BigInt(price))} USDC to merchant ${merchant}; the rest (${formatUsdc(amount - BigInt(price))} USDC) stays as change your agent collects`,
    privacy:
      "Ethereum shows your address and a round deposit, like any top-up; it shows neither the merchant nor the price. Only the agent learns the merchant.",
    steps: splitSteps(draft, m),
  };
}

export interface SplitL1 {
  getBlockNumber(): Promise<bigint>;
  getBlock(args: { blockTag: "latest" | "finalized" }): Promise<{ number: bigint | null; timestamp: bigint }>;
  getTransactionReceipt(args: { hash: Hex }): Promise<{ status: string; logs: Log[]; blockNumber: bigint }>;
  getLogs(args: { address: Hex; fromBlock: bigint; toBlock: bigint }): Promise<Log[]>;
}

export const splitL1 = (rpcUrl: string): SplitL1 => createPublicClient({ transport: http(rpcUrl) });

/** The router tx that made this draft's deposit, searching from `fromBlock`; undefined while none is found. */
export async function findSplitDeposit(l1: SplitL1, m: BridgeManifest, draft: DepositDraft, fromBlock: bigint): Promise<Hex | undefined> {
  const tip = await l1.getBlockNumber();
  const secretHash = draft.witness.secretHash.toLowerCase();
  for (let from = fromBlock; from <= tip; from += LOG_SCAN_CHUNK) {
    const to = from + LOG_SCAN_CHUNK - 1n > tip ? tip : from + LOG_SCAN_CHUNK - 1n;
    const logs = await l1.getLogs({ address: m.l1.router, fromBlock: from, toBlock: to });
    const hit = parseEventLogs({ abi: PERMIT2_DEPOSIT_ROUTER_ABI, eventName: "Deposit", logs }).find(
      (e) => e.args.secretHash.toLowerCase() === secretHash && e.args.amount === draft.intent.amount,
    );
    if (hit?.transactionHash) return hit.transactionHash;
  }
  return undefined;
}

/** The claim ticket of a mined deposit tx, which must be this draft's; throws while it is unmined or if it is another. */
export async function confirmSplitDeposit(l1: SplitL1, m: BridgeManifest, draft: DepositDraft, l1TxHash: Hex): Promise<ClaimTicket> {
  const receipt = await l1.getTransactionReceipt({ hash: l1TxHash });
  if (receipt.status !== "success") throw new CliError(`The deposit ${l1TxHash} reverted on L1; nothing was paid.`, "deposit_reverted");
  const deposit = parseEventLogs({ abi: PERMIT2_DEPOSIT_ROUTER_ABI, eventName: "Deposit", logs: receipt.logs }).find(
    (e) => e.address.toLowerCase() === m.l1.router.toLowerCase() && e.args.secretHash.toLowerCase() === draft.witness.secretHash.toLowerCase(),
  );
  if (!deposit) throw new CliError(`${l1TxHash} is not this payment's deposit.`, "deposit_mismatch");
  const submitted: DepositDraft = {
    ...draft,
    l1TxHash,
    submission: { account: deposit.args.depositor, chainId: m.l1.chainId, fromBlock: receipt.blockNumber, fromBlockHash: deposit.blockHash },
  };
  return ticketFromReceiptLogs(submitted, receipt.logs, m);
}

export function proofOfTicket(ticket: ClaimTicket): SplitPaymentProof {
  return splitProofOf(ticket.draft);
}

export { encodeTicket };
