/**
 * Built-in network registry.
 *
 * Addresses are what an agent needs to transact without asking anyone:
 * node RPC, the tokens it can pay with, and the faucet that mints testnet
 * tokens. A user config file can add tokens or override the node URL
 * (see config.ts), so a local network or a new deployment needs no release.
 */
import type { AztecNetwork } from "@galactica-net/x402-core";

export interface TokenInfo {
  symbol: string;
  name: string;
  /** AIP-20 token contract address on Aztec. */
  address: string;
  decimals: number;
  /** Dripper contract that may mint this token (testnet faucets only). */
  dripper?: string;
  /** Default faucet amount in human units. */
  faucetAmount?: string;
}

export interface NetworkConfig {
  /** Short name used on the command line. */
  name: string;
  /** CAIP-2 id carried in x402 challenges. */
  caip2: AztecNetwork;
  nodeUrl: string;
  /** Local network runs without real proofs; public networks need the prover. */
  proverEnabled: boolean;
  /** Pay fees through the canonical Sponsored FPC (free on testnet / local). */
  sponsoredFees: boolean;
  /** Settlement layer chain id — where deposits are signed. */
  l1ChainId: number;
  l1ChainName: string;
  /** Public L1 RPC for reads (deposit receipts, faucet amounts). Never signs. */
  l1RpcUrl: string;
  l1ExplorerUrl?: string;
  tokens: TokenInfo[];
}

/**
 * Canonical aztec-standards 5.0.1 Dripper and USDC: universal deploys with
 * salt 1337, so the addresses depend only on the artifacts. USDC's minter is
 * the Dripper (anyone may drip). Reproduce with `scripts/deploy-canonical.ts`;
 * the package's own `deployments.json` predates the 5.0.1 artifacts.
 */
const CANONICAL_DRIPPER = "0x064399d44c7ba2380dc7f8e8a8395189879ab7cc71c1ac5c4ca63a35a25815fd";
const CANONICAL_USDC = "0x2bb09ca02aeabb84fbe69537a0bf4b5ed57112466dc4666f9639157fe8dcfcf7";

export const NETWORKS: Record<string, NetworkConfig> = {
  testnet: {
    name: "testnet",
    caip2: "aztec:testnet",
    nodeUrl: "https://v5.testnet.rpc.aztec-labs.com",
    proverEnabled: true,
    sponsoredFees: true,
    l1ChainId: 11155111,
    l1ChainName: "Sepolia",
    l1RpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    l1ExplorerUrl: "https://sepolia.etherscan.io",
    tokens: [
      {
        symbol: "USDC",
        name: "USDC (testnet, faucet-minted)",
        address: CANONICAL_USDC,
        decimals: 6,
        dripper: CANONICAL_DRIPPER,
        faucetAmount: "10",
      },
    ],
  },
  local: {
    name: "local",
    caip2: "aztec:sandbox",
    nodeUrl: "http://localhost:8080",
    proverEnabled: false,
    sponsoredFees: true,
    l1ChainId: 31337,
    l1ChainName: "Anvil (local)",
    l1RpcUrl: "http://localhost:8545",
    tokens: [],
  },
};

export const DEFAULT_NETWORK = "testnet";
