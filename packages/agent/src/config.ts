/**
 * Agent home directory, user config, and the resolved network.
 *
 * Layout (default home `~/.aztec-x402`, override with AZTEC_X402_HOME):
 *
 *   config.json                 network choice, spend policy, extra tokens
 *   <network>/account.json      Aztec account keys (mode 0600) — never print
 *   <network>/pxe/              private state (notes, synced blocks)
 *   <network>/payments.jsonl    payment ledger, used for the daily limit
 *   <network>/requests.json     inference-money payment records (a request is never paid twice)
 *   <network>/deposits.json     pending bridge deposits (claim secrets)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { UsageError } from "./errors.js";
import { DEFAULT_NETWORK, NETWORKS, type NetworkConfig, type TokenInfo } from "./networks.js";

export interface SpendPolicy {
  /** Largest single payment, in human units of the paying token. */
  maxPerPayment: string;
  /** Rolling 24h total across all payments, in human units. */
  dailyLimit: string;
}

export interface UserConfig {
  network?: string;
  nodeUrl?: string;
  /** Hosted copy of the skill's funding page (assets/fund.html). */
  fundPageUrl?: string;
  policy?: Partial<SpendPolicy>;
  /** Extra tokens per network name, merged over the built-in registry. */
  tokens?: Record<string, TokenInfo[]>;
  /**
   * Consent to pay fees from the agent's own Fee Juice where the network has no
   * sponsor (mainnet), which names the agent's account as the payer of every
   * payment it makes (fees.ts).
   */
  publicFees?: boolean;
}

/** Hosted copy (Unfazed) of plugins/aztec-x402/skills/aztec-x402/assets/fund.html. */
export const DEFAULT_FUND_PAGE_URL = "https://aztec-x402.unfz.to/fund.html";

export function fundPageUrl(): string {
  return process.env.AZTEC_X402_FUND_PAGE_URL ?? readUserConfig().fundPageUrl ?? DEFAULT_FUND_PAGE_URL;
}

export const DEFAULT_POLICY: SpendPolicy = {
  maxPerPayment: "1",
  dailyLimit: "5",
};

export function homeDir(): string {
  return process.env.AZTEC_X402_HOME ?? join(homedir(), ".aztec-x402");
}

function configPath(): string {
  return join(homeDir(), "config.json");
}

export function readUserConfig(): UserConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function writeUserConfig(config: UserConfig): void {
  mkdirSync(homeDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n");
}

export interface ResolvedContext {
  network: NetworkConfig;
  policy: SpendPolicy;
  /** Directory holding this network's keys, PXE, and ledgers. */
  dataDir: string;
  /** The user agreed to pay fees as the named fee payer on a network without a sponsor (fees.ts). */
  publicFees: boolean;
}

/**
 * Resolve the active network: --network flag, then AZTEC_X402_NETWORK, then
 * config.json, then the default. The node URL can be overridden the same way.
 */
export function resolveContext(networkFlag?: string): ResolvedContext {
  const user = readUserConfig();
  const name = networkFlag ?? process.env.AZTEC_X402_NETWORK ?? user.network ?? DEFAULT_NETWORK;
  const base = NETWORKS[name];
  if (!base) {
    throw new UsageError(
      `Unknown network "${name}". Known networks: ${Object.keys(NETWORKS).join(", ")}`,
    );
  }

  const extraTokens = user.tokens?.[name] ?? [];
  const tokens = [
    ...base.tokens.filter((t) => !extraTokens.some((e) => sameAddress(e.address, t.address))),
    ...extraTokens,
  ];
  const nodeUrl =
    process.env.AZTEC_X402_NODE_URL ?? (user.network === name ? user.nodeUrl : undefined) ?? base.nodeUrl;

  const dataDir = join(homeDir(), name);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  return {
    network: { ...base, nodeUrl, tokens, l1RpcUrl: process.env.AZTEC_X402_L1_RPC_URL ?? base.l1RpcUrl },
    policy: { ...DEFAULT_POLICY, ...user.policy },
    dataDir,
    publicFees: envFlag(process.env.AZTEC_X402_PUBLIC_FEES) ?? user.publicFees === true,
  };
}

/** "1"/"true" and "0"/"false"; undefined when unset, so the config file decides. */
function envFlag(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  if (/^(1|true|yes)$/i.test(value)) return true;
  if (/^(0|false|no)$/i.test(value)) return false;
  throw new UsageError(`Expected true or false, got "${value}".`);
}

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function findToken(network: NetworkConfig, symbolOrAddress: string): TokenInfo | undefined {
  return network.tokens.find(
    (t) =>
      t.symbol.toLowerCase() === symbolOrAddress.toLowerCase() ||
      sameAddress(t.address, symbolOrAddress),
  );
}
