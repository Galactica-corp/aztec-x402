/**
 * Agent home directory, user config, and the resolved network.
 *
 * Layout (default home `~/.aztec-x402`, override with AZTEC_X402_HOME):
 *
 *   config.json                 network choice, spend policy, extra tokens
 *   <network>/account.json      Aztec account keys (mode 0600) — never print
 *   <network>/pxe/              private state (notes, synced blocks)
 *   <network>/payments.jsonl    payment ledger, used for the daily limit
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
  policy?: Partial<SpendPolicy>;
  /** Extra tokens per network name, merged over the built-in registry. */
  tokens?: Record<string, TokenInfo[]>;
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
  };
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
