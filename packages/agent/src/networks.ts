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
 * Canonical aztec-standards Dripper and USDC: universal deploys with salt 1337
 * under `DOM_SEP__CONTRACT_ADDRESS_V3`. USDC's minter is the Dripper (anyone may drip).
 * Reproduce with `scripts/deploy-canonical.ts`.
 */
const CANONICAL_DRIPPER = "0x0fda74986940cb777bfc0c52ed00b590cb05a267364c599d094d164ff1c795d4";
const CANONICAL_USDC = "0x08b5c7a74699f9336cb31f42872d9f067f52aef34afe2d2eb34dd0c3e3b36358";

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
