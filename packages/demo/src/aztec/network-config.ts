/**
 * Shared Aztec network helpers for demo scripts.
 *
 * PXE proving must match the node: local sandbox / `aztec start --local-network`
 * runs with `realProofs: false`, so keep `proverEnabled: false` there.
 * Sponsored FPC is independent of proving (local-network funds a canonical
 * SponsoredFPC address at genesis; register it in the wallet to pay fees).
 */
import { NETWORKS, type NetworkConfig } from "@galactica-net/x402-agent/aztec";

export function isSandboxNetwork(network: string): boolean {
  return network === "aztec:sandbox";
}

/** Match the local network's `realProofs: false` default. */
export function shouldEnableProver(network: string): boolean {
  return !isSandboxNetwork(network);
}

/** The agent package's network for a deploy.json `network` (CAIP-2), with deploy.json's node URL. */
export function merchantNetwork(network: string, nodeUrl: string): NetworkConfig {
  return { ...(isSandboxNetwork(network) ? NETWORKS.local : NETWORKS.testnet), nodeUrl };
}
