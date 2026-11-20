/**
 * Moving the inference-money USDC between Ethereum and the agent's Aztec
 * account: a private deposit the user signs in their browser wallet (`deposit`),
 * and an exit back to Ethereum whose last step, the portal's withdraw, the user
 * sends from the same page (`withdraw`).
 *
 * Each deposit record holds its draft, the only copy of the claim salt, and
 * each withdrawal its exit ticket. Both files are 0600 and records are never
 * deleted: a record that looks finished may still be needed after a reorg.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import {
  TOKEN_PORTAL_ABI,
  decodeClaimTicket,
  decodeDepositDraft,
  decodeExitTicket,
  type BridgeManifest,
  type ClaimTicket,
  type DepositDraft,
  type ExitTicket,
  type OutboxProof,
} from "@galactica-net/inference-money-core";
import { encodeFunctionData } from "viem";
import type { NetworkConfig } from "../networks.js";
import { UsageError } from "../errors.js";
import type { FundingPlan, Hex, PlanStep } from "./bridge.js";
import { splitSteps } from "./split.js";

export type UsdcDepositStatus = "awaiting_deposit" | "deposited" | "claimed" | "consumed" | "not_deposited";

export interface UsdcDepositRecord {
  id: string;
  createdAt: string;
  recipient: string;
  amount: string;
  /** encodeTicket("draft", …): holds the claim salt. */
  draft: string;
  /** L1 block to search for the deposit from (the finalized block before signing). */
  l1FromBlock: string;
  l1TxHash?: string;
  /** encodeTicket("claim", …) once the deposit is mined. */
  ticket?: string;
  depositor?: string;
  status: UsdcDepositStatus;
  error?: string;
}

/**
 * `exiting`: about to burn; no tx hash known yet. `unconfirmed`: the burn tx was handed to the node but its outcome is
 * unknown (`l2TxHash` set). `exited`: burned, ticket known, waiting for the epoch proof and the L1 withdraw.
 * `unknown`: interrupted before any hash was known; the balance tells whether it burned.
 */
export type UsdcWithdrawalStatus = "exiting" | "unconfirmed" | "exited" | "withdrawn" | "reverted" | "unknown";

export interface UsdcWithdrawalRecord {
  id: string;
  createdAt: string;
  from: string;
  recipient: string;
  amount: string;
  asMerchant: boolean;
  l2TxHash?: string;
  /** encodeTicket("exit", …) once the burn is checkpointed. */
  ticket?: string;
  l1TxHash?: string;
  status: UsdcWithdrawalStatus;
  error?: string;
}

function readRecords<T>(path: string): T[] {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : [];
}

function saveRecord<T extends { id: string }>(path: string, record: T): void {
  const all = readRecords<T>(path).filter((r) => r.id !== record.id);
  all.push(record);
  // Write-then-rename: a crash never leaves the only copy of a salt half-written.
  writeFileSync(`${path}.tmp`, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

const depositsPath = (dataDir: string) => join(dataDir, "usdc-deposits.json");
const withdrawalsPath = (dataDir: string) => join(dataDir, "usdc-withdrawals.json");

export const readUsdcDeposits = (dataDir: string) => readRecords<UsdcDepositRecord>(depositsPath(dataDir));
export const saveUsdcDeposit = (dataDir: string, r: UsdcDepositRecord) => saveRecord(depositsPath(dataDir), r);
export const readUsdcWithdrawals = (dataDir: string) => readRecords<UsdcWithdrawalRecord>(withdrawalsPath(dataDir));
export const saveUsdcWithdrawal = (dataDir: string, r: UsdcWithdrawalRecord) => saveRecord(withdrawalsPath(dataDir), r);

export const depositDraftOf = (r: UsdcDepositRecord): DepositDraft => decodeDepositDraft(r.draft);
export const depositTicketOf = (r: UsdcDepositRecord): ClaimTicket | undefined => (r.ticket ? decodeClaimTicket(r.ticket) : undefined);
export const exitTicketOf = (r: UsdcWithdrawalRecord): ExitTicket | undefined => (r.ticket ? decodeExitTicket(r.ticket) : undefined);

/** Whether a withdrawal may still burn or is burned and not yet paid out: a second exit waits until it is settled. */
export const isOpenWithdrawal = (r: UsdcWithdrawalRecord) => r.status === "exiting" || r.status === "unconfirmed" || r.status === "exited";

/** The bridge on this network, or a usage error naming the override. */
export function requireBridgeManifest(network: NetworkConfig, manifest: BridgeManifest | undefined): BridgeManifest {
  if (!manifest) {
    throw new UsageError(
      `No inference-money bridge is known for network ${network.name}; set AZTEC_X402_BRIDGE_MANIFEST to its manifest file.`,
      "no_bridge",
    );
  }
  return manifest;
}

/**
 * The page for a private USDC deposit to the agent: approve Permit2 once, sign the permit, send the deposit. `from`,
 * when the account is already bound, is the only Ethereum address whose deposit it can claim; the page refuses others.
 */
export function buildUsdcDepositPlan(
  network: NetworkConfig,
  m: BridgeManifest,
  draft: DepositDraft,
  agent: string,
  formatUsdc: (v: bigint) => string,
  from?: Hex,
): FundingPlan {
  const amount = formatUsdc(draft.intent.amount);
  return {
    v: 1,
    kind: "fund",
    network: network.name,
    l1ChainId: m.l1.chainId,
    l1ChainName: network.l1ChainName,
    l1ExplorerUrl: network.l1ExplorerUrl,
    agent,
    amount,
    token: { symbol: "USDC", decimals: 6, address: m.l1.usdc },
    portal: m.l1.portal,
    ...(from ? { from } : {}),
    title: "Deposit USDC to your agent",
    result: `${amount} USDC in its private balance`,
    privacy:
      `${network.l1ChainName} shows your address and the amount, like any bridge deposit; on Aztec the agent's balance stays private. ` +
      (from
        ? `This account only accepts deposits from ${from}.`
        : "This first deposit binds the agent's account to the address you sign with, for good: later deposits must come from it, and a user account withdraws only there."),
    steps: splitSteps(draft, m),
  };
}

/** The portal's withdraw for an exit whose epoch is proven: anyone may send it, the recipient is fixed by the message. */
export function withdrawStep(t: ExitTicket, p: OutboxProof, m: BridgeManifest, formatUsdc: (v: bigint) => string): PlanStep {
  return {
    id: "withdraw",
    label: `Withdraw ${formatUsdc(t.amount)} USDC to ${t.recipient} (you pay the gas)`,
    to: m.l1.portal,
    data: encodeFunctionData({
      abi: TOKEN_PORTAL_ABI,
      functionName: "withdraw",
      args: [t.recipient, t.amount, false, p.epoch, p.numCheckpointsInEpoch, p.leafIndex, [...p.path]],
    }),
  };
}

export function buildWithdrawPlan(
  network: NetworkConfig,
  m: BridgeManifest,
  t: ExitTicket,
  p: OutboxProof,
  agent: string,
  formatUsdc: (v: bigint) => string,
): FundingPlan {
  const amount = formatUsdc(t.amount);
  return {
    v: 1,
    kind: "withdraw",
    network: network.name,
    l1ChainId: m.l1.chainId,
    l1ChainName: network.l1ChainName,
    l1ExplorerUrl: network.l1ExplorerUrl,
    agent,
    amount,
    token: { symbol: "USDC", decimals: 6, address: m.l1.usdc },
    portal: m.l1.portal,
    title: "Withdraw USDC to Ethereum",
    result: `${amount} USDC to ${t.recipient}`,
    privacy: `${network.l1ChainName} shows the recipient and the amount. Any account may send this transaction; the USDC goes only to ${t.recipient}.`,
    steps: [withdrawStep(t, p, m, formatUsdc)],
  };
}
