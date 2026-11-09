/**
 * Everything a merchant server needs to take ref and split payments in the
 * inference-money USDC, wired from deploy.json:
 *
 * - a durable store (SQLite) and the reference secret, both under DATA_DIR;
 * - the facilitator signer, with split payments when an L1 RPC is known;
 * - the background jobs (replay stored proofs, consolidate, claim splits).
 *
 * The merchant's wallet must be persistent (see real-server.ts): a note a
 * buyer delivered offchain lives only in it until the next consolidation.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import type { FeePaymentMethod } from "@aztec-labs/aztec.js/fee";
import type { AztecNode } from "@aztec-labs/aztec.js/node";
import {
  MerchantJobs,
  SplitMerchant,
  TokenRegistry,
  type PXEWallet,
  type TokenAdapter,
} from "@galactica-net/x402-agent/aztec";
import type { PaymentMode, PaymentStateStore } from "@galactica-net/x402-core";
import { sqliteStateStore } from "@galactica-net/x402-middleware";
import { createPublicClient, http } from "viem";
import { RealFacilitatorAztecSigner } from "./facilitator-signer.js";

export interface MerchantConfig {
  network: string;
  tokenAddress: string;
  l1RpcUrl?: string;
  manifestPath?: string;
}

export interface MerchantOptions {
  config: MerchantConfig;
  dataDir: string;
  node: AztecNode;
  wallet: PXEWallet;
  account: { address: AztecAddress };
  fee?: { paymentMethod: FeePaymentMethod };
  /** Turn split payments off even when an L1 RPC is configured. */
  noSplit?: boolean;
  /** Split deposits at or above this price wait for L1 finality. */
  finalizedAbove?: bigint;
  log?: (message: string) => void;
}

export interface Merchant {
  tokens: TokenRegistry;
  token: TokenAdapter;
  signer: RealFacilitatorAztecSigner;
  split?: SplitMerchant;
  store: PaymentStateStore;
  secret: Uint8Array;
  jobs: MerchantJobs;
  /** The modes to offer on the token's routes, most private first. */
  modes: PaymentMode[];
}

/** The reference secret: X402_REF_SECRET (hex) or a random one kept in DATA_DIR, readable by its owner only. */
export function loadSecret(dataDir: string): Uint8Array {
  const fromEnv = process.env.X402_REF_SECRET;
  if (fromEnv) return Buffer.from(fromEnv.replace(/^0x/, ""), "hex");
  const path = join(dataDir, "x402-ref-secret");
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  return Buffer.from(readFileSync(path, "utf-8").trim(), "hex");
}

async function loadManifest(config: MerchantConfig) {
  const { parseManifest } = await import("@galactica-net/inference-money-core");
  if (config.manifestPath) return parseManifest(JSON.parse(readFileSync(config.manifestPath, "utf-8")));
  const { TESTNET_MANIFEST } = await import("@galactica-net/inference-money-core/deployments");
  return parseManifest(TESTNET_MANIFEST);
}

export async function openMerchant(o: MerchantOptions): Promise<Merchant> {
  const log = o.log ?? console.log;
  const tokens = new TokenRegistry({ node: o.node, wallet: o.wallet, account: o.account.address, fee: o.fee });
  const token = await tokens.get(o.config.tokenAddress);
  const store = sqliteStateStore(join(o.dataDir, "x402-state.sqlite"));
  const secret = loadSecret(o.dataDir);

  let split: SplitMerchant | undefined;
  if (token.kind === "inference-money" && o.config.l1RpcUrl && !o.noSplit) {
    const { registerBridgeContracts, registerSponsor } = await import("@galactica-net/inference-money-core");
    const manifest = await loadManifest(o.config);
    if (manifest.l2.token.address.toLowerCase() !== o.config.tokenAddress.toLowerCase()) {
      throw new Error(`The bridge manifest's token ${manifest.l2.token.address} is not the token sold (${o.config.tokenAddress}).`);
    }
    await registerSponsor(o.wallet, manifest);
    await registerBridgeContracts(o.wallet, manifest);
    split = await SplitMerchant.create({
      manifest,
      l1: createPublicClient({ transport: http(o.config.l1RpcUrl) }),
      node: o.node,
      wallet: o.wallet,
      merchant: o.account.address,
      finalizedAbove: o.finalizedAbove,
      log,
    });
    log(
      split.listingTime === undefined
        ? "Split payments: on, but this merchant's listing is not found yet; they are offered once it is."
        : `Split payments: on (listing landed at ${new Date(Number(split.listingTime) * 1000).toISOString()}).`,
    );
  }

  const signer = new RealFacilitatorAztecSigner(o.account, o.node, tokens, split);
  const jobs = new MerchantJobs({
    store,
    receive: async (asset, proof, expected) => {
      const t = await tokens.get(asset);
      if (!t.receivePayment) throw new Error(`${t.kind} takes no ref payments`);
      return t.receivePayment(proof, expected);
    },
    consolidate: token.consolidate
      ? async () => {
          const tx = await token.consolidate?.();
          log(tx ? `Consolidated the merchant's notes in ${tx}.` : "Nothing to consolidate.");
        }
      : undefined,
    split,
    log,
  });
  let modes: PaymentMode[] = ["commitment"];
  if (token.kind === "inference-money") modes = split ? ["ref", "split", "commitment"] : ["ref", "commitment"];
  return { tokens, token, signer, split, store, secret, jobs, modes };
}
