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
 * Canonical aztec-standards Dripper and USDC under the 6.0.0-rc.3 address
 * derivation (`DOM_SEP__CONTRACT_ADDRESS_V3`): universal deploys with salt
 * 1337. The standards package is still 6.0.0-rc.1 (no rc.3 publish); these
 * addresses are what the rc.3 SDK computes from those artifacts. USDC's minter
 * is the Dripper (anyone may drip). Reproduce with `scripts/deploy-canonical.ts`.
 */
const CANONICAL_DRIPPER = "0x1f230236880bf1a0604ae52f7ee111a94c4fa48cb271d2c3973ee1ac8911c49c";
const CANONICAL_USDC = "0x105e7bafa36de6e4946349c0aa2b3a724761168392d1fe2632ed5649ef1a5c22";

export const NETWORKS: Record<string, NetworkConfig> = {
  testnet: {
    name: "testnet",
    caip2: "aztec:testnet",
    // Public testnet RPC. Contract addresses use the V3 separator, so rc.1 addresses are not on this rollup.
    nodeUrl: "https://aztec-testnet.drpc.org",
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
