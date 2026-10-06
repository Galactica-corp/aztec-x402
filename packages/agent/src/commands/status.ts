import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import { loadAccountKeys } from "../aztec/keystore.js";
import { homeDir, readUserConfig, writeUserConfig, type ResolvedContext } from "../config.js";
import { UsageError } from "../errors.js";
import { NETWORKS } from "../networks.js";
import { readLedger, spentLast24h } from "../policy.js";
import { formatTokenAmount } from "../x402.js";

/** Fast overview: no PXE sync, safe to run first in every session. */
export async function status(ctx: ResolvedContext) {
  const keys = loadAccountKeys(ctx.dataDir);
  let node: { reachable: boolean; blockNumber?: number; nodeVersion?: string; error?: string };
  try {
    const client = createAztecNodeClient(ctx.network.nodeUrl);
    const [blockNumber, info] = await Promise.all([client.getBlockNumber(), client.getNodeInfo()]);
    node = { reachable: true, blockNumber, nodeVersion: info.nodeVersion };
  } catch (error) {
    node = { reachable: false, error: error instanceof Error ? error.message : String(error) };
  }
  return {
    home: homeDir(),
    network: ctx.network.name,
    caip2: ctx.network.caip2,
    nodeUrl: ctx.network.nodeUrl,
    node,
    wallet: keys ? { address: keys.address } : null,
    policy: ctx.policy,
    spent24h: Object.fromEntries(
      ctx.network.tokens.map((t) => [t.symbol, formatTokenAmount(spentLast24h(ctx.dataDir, t), t)]),
    ),
    tokens: ctx.network.tokens.map((t) => ({
      symbol: t.symbol,
      address: t.address,
      decimals: t.decimals,
      faucet: Boolean(t.dripper),
    })),
    nextStep: !node.reachable
      ? "Node unreachable — check network access or AZTEC_X402_NODE_URL."
      : !keys
        ? "Run `aztec-x402 wallet create`."
        : "Ready. Check funds with `aztec-x402 balance`.",
  };
}

export function history(ctx: ResolvedContext, opts: { limit?: number }) {
  const entries = readLedger(ctx.dataDir).sort((a, b) => b.at.localeCompare(a.at));
  return { network: ctx.network.name, payments: entries.slice(0, opts.limit ?? 20) };
}

const SETTABLE = ["network", "nodeUrl", "policy.maxPerPayment", "policy.dailyLimit"] as const;

export function configGet() {
  return { path: `${homeDir()}/config.json`, config: readUserConfig(), settable: SETTABLE };
}

export function configSet(key: string, value: string) {
  const config = readUserConfig();
  switch (key) {
    case "network":
      if (!NETWORKS[value]) throw new UsageError(`Unknown network "${value}"`);
      config.network = value;
      break;
    case "nodeUrl":
      config.nodeUrl = value;
      break;
    case "policy.maxPerPayment":
    case "policy.dailyLimit":
      if (!/^\d+(\.\d+)?$/.test(value)) throw new UsageError(`${key} must be a decimal amount`);
      config.policy = { ...config.policy, [key.split(".")[1]]: value };
      break;
    default:
      throw new UsageError(`Unknown key "${key}". Settable: ${SETTABLE.join(", ")}`);
  }
  writeUserConfig(config);
  return configGet();
}
