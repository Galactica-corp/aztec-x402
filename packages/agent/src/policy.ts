/**
 * Spend policy and payment ledger.
 *
 * The policy lives in the CLI, not in the agent's prompt: a payment is only
 * made when the challenge passes every check here. The ledger is an
 * append-only JSONL file; the rolling 24h total counts pending and paid
 * entries, so a crash mid-payment never frees up budget.
 */
import { appendFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { parsePrice } from "@galactica-net/x402-core";
import type { NetworkConfig, TokenInfo } from "./networks.js";
import type { SpendPolicy } from "./config.js";
import { findToken, sameAddress } from "./config.js";
import { PolicyError, UsageError } from "./errors.js";
import { formatTokenAmount } from "./x402.js";

export interface PaymentLimits {
  /** Per-call cap the agent passes with --max-amount (human units). */
  maxAmount: string;
  /** Optional pin on the token symbol or address. */
  expectAsset?: string;
  /** Optional pin on the merchant's Aztec address. */
  expectPayTo?: string;
}

export interface LedgerEntry {
  id: string;
  /** `uncertain`: the transfer may have been sent but inclusion was not confirmed. */
  status: "pending" | "paid" | "failed" | "uncertain";
  url: string;
  network: string;
  asset: string;
  token: string;
  amount: string;
  amountBaseUnits: string;
  payTo: string;
  nonce?: string;
  txHash?: string;
  error?: string;
  at: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function ledgerPath(dataDir: string): string {
  return join(dataDir, "payments.jsonl");
}

export function readLedger(dataDir: string): LedgerEntry[] {
  const path = ledgerPath(dataDir);
  if (!existsSync(path)) return [];
  // Later lines for the same id supersede earlier ones.
  const byId = new Map<string, LedgerEntry>();
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const entry: LedgerEntry = JSON.parse(line);
    byId.set(entry.id, { ...byId.get(entry.id), ...entry });
  }
  return [...byId.values()];
}

export function appendLedger(dataDir: string, entry: Partial<LedgerEntry> & { id: string }): void {
  appendFileSync(ledgerPath(dataDir), JSON.stringify({ ...entry, at: new Date().toISOString() }) + "\n", {
    mode: 0o600,
  });
}

/** Spent (pending + paid) in the last 24h for one token, in base units. */
export function spentLast24h(dataDir: string, token: TokenInfo, now = Date.now()): bigint {
  return readLedger(dataDir)
    .filter((e) => e.status !== "failed" && sameAddress(e.asset, token.address))
    .filter((e) => now - Date.parse(e.at) < DAY_MS)
    .reduce((sum, e) => sum + BigInt(e.amountBaseUnits), 0n);
}

/**
 * Check one payment requirement against the per-call limits and the
 * configured policy. Throws PolicyError on any violation; returns the token.
 */
/** The fields of an x402 payment requirement the policy looks at. */
export interface PayableRequirement {
  network: string;
  asset: string;
  amount: string;
  payTo: string;
}

export function checkPayment(
  req: PayableRequirement,
  limits: PaymentLimits,
  policy: SpendPolicy,
  network: NetworkConfig,
  dataDir: string,
): TokenInfo {
  const token = findToken(network, req.asset);
  if (!token) {
    throw new PolicyError(`Refusing to pay in unknown asset ${req.asset}`, { asset: req.asset });
  }
  if (req.network !== network.caip2) {
    throw new PolicyError(`Challenge is for ${req.network}, agent is on ${network.caip2}`);
  }
  if (limits.expectAsset) {
    const expected = findToken(network, limits.expectAsset);
    if (!expected || !sameAddress(expected.address, token.address)) {
      throw new PolicyError(`Challenge asks for ${token.symbol}, expected ${limits.expectAsset}`);
    }
  }
  if (limits.expectPayTo && !sameAddress(limits.expectPayTo, req.payTo)) {
    throw new PolicyError(`Challenge pays ${req.payTo}, expected ${limits.expectPayTo}`);
  }

  const amount = BigInt(req.amount);
  const price = formatTokenAmount(amount, token);
  const maxAmount = parseAmount(limits.maxAmount, token, "--max-amount");
  const maxPerPayment = parseAmount(policy.maxPerPayment, token, "policy.maxPerPayment");
  const dailyLimit = parseAmount(policy.dailyLimit, token, "policy.dailyLimit");

  if (amount > maxAmount) {
    throw new PolicyError(`Price ${price} ${token.symbol} exceeds --max-amount ${limits.maxAmount}`, {
      price,
      maxAmount: limits.maxAmount,
    });
  }
  if (amount > maxPerPayment) {
    throw new PolicyError(
      `Price ${price} ${token.symbol} exceeds the per-payment policy limit ${policy.maxPerPayment}`,
      { price, maxPerPayment: policy.maxPerPayment },
    );
  }
  const spent = spentLast24h(dataDir, token);
  if (spent + amount > dailyLimit) {
    throw new PolicyError(
      `Paying ${price} ${token.symbol} would exceed the 24h limit ${policy.dailyLimit} (already spent ${formatTokenAmount(spent, token)})`,
      { price, spent24h: formatTokenAmount(spent, token), dailyLimit: policy.dailyLimit },
    );
  }
  return token;
}

export function parseAmount(value: string, token: TokenInfo, label: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(value.trim())) {
    throw new UsageError(`${label} must be a decimal amount like 0.05, got "${value}"`);
  }
  const [, fraction = ""] = value.split(".");
  if (fraction.length > token.decimals) {
    throw new UsageError(`${label} has more than ${token.decimals} decimals for ${token.symbol}`);
  }
  return parsePrice(value, token.decimals);
}
