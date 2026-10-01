/**
 * Pending L1 → Aztec deposits. Each record holds the claim secret, so the
 * file is 0600 and the secret never leaves the CLI: the funding page only
 * ever sees its hash, inside the deposit calldata.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export type DepositStatus = "awaiting_l1" | "l1_confirmed" | "claiming" | "claimed" | "failed";

export interface DepositRecord {
  id: string;
  bridge: string;
  /** Agent's Aztec address that receives the funds. */
  recipient: string;
  amount: string;
  secret: string;
  secretHash: string;
  status: DepositStatus;
  createdAt: string;
  l1From?: string;
  l1TxHash?: string;
  messageHash?: string;
  leafIndex?: string;
  claimTxHash?: string;
  error?: string;
}

function depositsPath(dataDir: string): string {
  return join(dataDir, "deposits.json");
}

export function readDeposits(dataDir: string): DepositRecord[] {
  const path = depositsPath(dataDir);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function saveDeposit(dataDir: string, record: DepositRecord): void {
  const all = readDeposits(dataDir).filter((d) => d.id !== record.id);
  all.push(record);
  writeFileSync(depositsPath(dataDir), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
}

/** Deposit view safe to show on the page or print: no secret. */
export function publicView(record: DepositRecord): Omit<DepositRecord, "secret"> {
  const { secret: _secret, ...rest } = record;
  return rest;
}
