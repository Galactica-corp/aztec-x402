/**
 * Everything a merchant server needs to take x402 payments on Aztec, in one
 * call: the merchant's persistent wallet, the payment store, the reference
 * secret, the facilitator, split payments (with an Ethereum RPC) and the
 * background jobs (replay stored proofs, consolidate, claim splits).
 *
 * ```ts
 * const merchant = await createMerchant({ network: "testnet", keys, token: USDC, dataDir: "./x402-data" });
 * app.use(merchant.middleware({ "/api/infer": { amount: "10000" } }));
 * ```
 *
 * The merchant's duties come down to two: keep the account keys safe, and keep
 * `dataDir` on storage that survives restarts and redeploys. Once a payment
 * is consolidated (within hours), the keys alone recover it; until then it
 * also lives in `dataDir`.
 */
import { hkdfSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr, GrumpkinScalar } from "@aztec-labs/aztec.js/fields";
import type { AztecNode } from "@aztec-labs/aztec.js/node";
import type { BridgeManifest } from "@galactica-net/inference-money-core";
import type { PaymentMode, PaymentStateStore } from "@galactica-net/x402-core";
import { ExactAztecFacilitatorScheme } from "@galactica-net/x402-mechanism/exact/facilitator";
import {
  createPaymentMiddleware,
  sqliteStateStore,
  type MiddlewareConfig,
  type RouteConfig,
  type RoutesConfig,
} from "@galactica-net/x402-middleware";
import { createPublicClient, http } from "viem";
import { NETWORKS, type NetworkConfig } from "../networks.js";
import { AztecFacilitatorSigner } from "./facilitator-signer.js";
import { MerchantJobs, type MerchantStatus } from "./merchant-jobs.js";
import type { PXEWallet } from "./pxe-wallet.js";
import { openWallet, sponsoredFeePayment } from "./session.js";
import { SplitMerchant } from "./split-merchant.js";
import type { TokenAdapter } from "./tokens/adapter.js";
import { TokenRegistry } from "./tokens/registry.js";

/** The merchant's Aztec account. `type` is the account contract: "schnorr" (deployed, the default) or "schnorr_initializerless". */
export interface MerchantKeys {
  secretKey: string;
  signingKey: string;
  salt: string;
  type?: "schnorr" | "schnorr_initializerless";
  /** When given, checked against the address the keys derive. */
  address?: string;
}

export interface CreateMerchantOptions {
  /** A network from {@link NETWORKS} by name ("testnet", "local"), or a full config. */
  network: string | NetworkConfig;
  /** Overrides the network's node URL. */
  nodeUrl?: string;
  keys: MerchantKeys;
  /** The token to charge in (its address). */
  token: string;
  /**
   * The wallet's store (`pxe/`), the payment store (`x402-state.sqlite`): the
   * one folder that must survive restarts and redeploys. Never a container's
   * throwaway filesystem.
   */
  dataDir: string;
  /** An Ethereum RPC: turns on split payments (one L1 deposit pays) for the inference-money token. */
  l1RpcUrl?: string;
  /** The bridge deployment (default: the SDK's testnet deployment). */
  manifest?: BridgeManifest;
  /** Split payments off even with an L1 RPC. */
  noSplit?: boolean;
  /** Split deposits at or above this price (base units) wait for L1 finality. */
  finalizedAbove?: bigint;
  /**
   * The reference secret (≥ 32 bytes). By default a legacy `dataDir/x402-ref-secret`
   * is used if present, else one derived from the account's secret key, the
   * same on every instance and nothing to store.
   */
  secret?: Uint8Array;
  /** A store shared by instances on several hosts (default: SQLite in `dataDir`, for one host). */
  store?: PaymentStateStore;
  /** Pay fees through the sponsor (default: the network's setting). */
  sponsoredFees?: boolean;
  consolidateEveryMs?: number;
  claimPollMs?: number;
  leaseMs?: number;
  /** Stop the background jobs on SIGTERM and SIGINT before the process exits (default true). */
  handleSignals?: boolean;
  log?: (message: string) => void;
}

/** A route as {@link Merchant.middleware} takes it: only `amount` is needed, the rest defaults to the merchant's. */
export type MerchantRoute = Partial<RouteConfig> & Pick<RouteConfig, "amount">;

export interface Merchant {
  address: AztecAddress;
  network: NetworkConfig;
  dataDir: string;
  node: AztecNode;
  wallet: PXEWallet;
  tokens: TokenRegistry;
  token: TokenAdapter;
  /** The payments the token's routes offer by default, most private first. */
  modes: PaymentMode[];
  signer: AztecFacilitatorSigner;
  facilitator: ExactAztecFacilitatorScheme;
  split?: SplitMerchant;
  store: PaymentStateStore;
  secret: Uint8Array;
  jobs: MerchantJobs;
  /** The routes filled in with the merchant's network, token, address and modes. */
  routes(routes: Record<string, MerchantRoute>): RoutesConfig;
  /** The x402 middleware for these routes. */
  middleware(
    routes: Record<string, MerchantRoute>,
    config?: Omit<MiddlewareConfig, "facilitator" | "store" | "secret">,
  ): ReturnType<typeof createPaymentMiddleware>;
  /** What the background jobs know; `warnings` is empty when nothing needs a person. */
  status(): Promise<MerchantStatus>;
  /** Stops the background jobs, gives their lease to another instance and closes the store. */
  stop(): Promise<void>;
}

export const PXE_DIR = "pxe";
export const STORE_FILE = "x402-state.sqlite";
export const LEGACY_SECRET_FILE = "x402-ref-secret";

/** The reference secret derived from the merchant's secret key: deterministic, 32 bytes, bound to the address. */
export function deriveRefSecret(secretKey: string, address: AztecAddress | string): Uint8Array {
  const ikm = Buffer.from(secretKey.replace(/^0x/, "").padStart(64, "0"), "hex");
  return new Uint8Array(hkdfSync("sha256", ikm, "x402-ref-secret-v1", address.toString().toLowerCase(), 32));
}

/** The secret to use: the explicit one, else a legacy file in `dataDir`, else derived from the keys. */
export function resolveRefSecret(o: { secret?: Uint8Array; dataDir: string; secretKey: string; address: AztecAddress | string }): {
  secret: Uint8Array;
  source: "option" | "file" | "derived";
} {
  if (o.secret) return { secret: o.secret, source: "option" };
  const legacy = join(o.dataDir, LEGACY_SECRET_FILE);
  if (existsSync(legacy)) return { secret: Buffer.from(readFileSync(legacy, "utf-8").trim(), "hex"), source: "file" };
  return { secret: deriveRefSecret(o.secretKey, o.address), source: "derived" };
}

export type StorageState = "fresh" | "ok" | "wallet-lost" | "store-lost";

/**
 * What `dataDir` holds before anything opens it. One half missing means the
 * storage did not persist: a lost wallet store loses the notes not yet
 * consolidated (the payment store can restore those within 26 h), a lost
 * payment store loses served marks and split claims.
 */
export function checkStorage(dataDir: string, store = true): StorageState {
  const hasWallet = existsSync(join(dataDir, PXE_DIR));
  if (!store) return hasWallet ? "ok" : "fresh";
  const hasStore = existsSync(join(dataDir, STORE_FILE));
  if (hasWallet === hasStore) return hasWallet ? "ok" : "fresh";
  return hasWallet ? "store-lost" : "wallet-lost";
}

/** Fills each route in with the merchant's defaults; what a route sets wins. */
export function merchantRoutes(
  routes: Record<string, MerchantRoute>,
  defaults: Pick<RouteConfig, "network" | "asset" | "payTo" | "modes"> & { maxTimeoutSeconds?: number },
): RoutesConfig {
  const filled: RoutesConfig = {};
  for (const [path, route] of Object.entries(routes)) {
    filled[path] = {
      network: route.network ?? defaults.network,
      asset: route.asset ?? defaults.asset,
      payTo: route.payTo ?? defaults.payTo,
      amount: route.amount,
      maxTimeoutSeconds: route.maxTimeoutSeconds ?? defaults.maxTimeoutSeconds ?? 600,
      modes: route.modes ?? defaults.modes,
      ...(route.description === undefined ? {} : { description: route.description }),
    };
  }
  return filled;
}

interface SignalSource {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
  kill(pid: number, signal: NodeJS.Signals): unknown;
  pid: number;
}

/**
 * On SIGTERM or SIGINT, runs `stop` and then raises the signal again, so the
 * process exits as it would have. Returns a function that removes the hooks.
 */
export function stopOnSignals(stop: () => Promise<void>, proc: SignalSource = process, log: (m: string) => void = () => {}): () => void {
  type Signal = "SIGTERM" | "SIGINT";
  const signals: Signal[] = ["SIGTERM", "SIGINT"];
  const handler = (signal: Signal) => () => {
    remove();
    log(`${signal}: stopping the merchant's background jobs.`);
    void stop()
      .catch((e) => log(`Stopping failed: ${String(e)}`))
      .finally(() => proc.kill(proc.pid, signal));
  };
  const handlers: Record<Signal, () => void> = { SIGTERM: handler("SIGTERM"), SIGINT: handler("SIGINT") };
  const remove = () => signals.forEach((s) => proc.off(s, handlers[s]));
  signals.forEach((s) => proc.once(s, handlers[s]));
  return remove;
}

function networkOf(o: CreateMerchantOptions): NetworkConfig {
  const base = typeof o.network === "string" ? NETWORKS[o.network] : o.network;
  if (!base) throw new Error(`Unknown network "${String(o.network)}" (known: ${Object.keys(NETWORKS).join(", ")}).`);
  return o.nodeUrl ? { ...base, nodeUrl: o.nodeUrl } : base;
}

async function loadManifest(manifest?: BridgeManifest): Promise<BridgeManifest> {
  if (manifest) return manifest;
  const { parseManifest } = await import("@galactica-net/inference-money-core");
  const { TESTNET_MANIFEST } = await import("@galactica-net/inference-money-core/deployments");
  return parseManifest(TESTNET_MANIFEST);
}

export async function createMerchant(o: CreateMerchantOptions): Promise<Merchant> {
  const log = o.log ?? console.log;
  const network = networkOf(o);
  const dataDir = resolve(o.dataDir);

  const storage = checkStorage(dataDir, o.store === undefined);
  log(`Merchant data in ${dataDir}: keep it on storage that survives restarts and redeploys.`);
  if (storage === "wallet-lost") {
    log(
      "WARNING: the payment store is here but the wallet's store is not (lost storage?). Payments since the last " +
        "consolidation are taken in again from the payment store before the next consolidation; those older than 26 h cannot be.",
    );
  } else if (storage === "store-lost") {
    log(
      "WARNING: the wallet's store is here but the payment store is not (lost storage?). Served references and pending " +
        "split claims are gone: a buyer may be served twice, and unclaimed split deposits are left to their buyers.",
    );
  }

  const { node, wallet } = await openWallet(network, dataDir);
  const secretKey = Fr.fromString(o.keys.secretKey);
  const salt = Fr.fromString(o.keys.salt);
  const signingKey = GrumpkinScalar.fromString(o.keys.signingKey);
  const account =
    o.keys.type === "schnorr_initializerless"
      ? await wallet.createSchnorrInitializerlessAccount(secretKey, salt, signingKey)
      : await wallet.createSchnorrAccount(secretKey, salt, signingKey);
  const address = account.address;
  if (o.keys.address && o.keys.address.toLowerCase() !== address.toString().toLowerCase()) {
    throw new Error(`The keys derive ${address}, not ${o.keys.address}: wrong keys, or the wrong account type ("${o.keys.type ?? "schnorr"}").`);
  }

  const fee = (o.sponsoredFees ?? network.sponsoredFees) ? { paymentMethod: await sponsoredFeePayment(wallet) } : undefined;
  const tokens = new TokenRegistry({ node, wallet, account: address, fee });
  const token = await tokens.get(o.token);

  let split: SplitMerchant | undefined;
  if (token.kind === "inference-money" && o.l1RpcUrl && !o.noSplit) {
    const { registerBridgeContracts, registerSponsor } = await import("@galactica-net/inference-money-core");
    const manifest = await loadManifest(o.manifest);
    if (manifest.l2.token.address.toLowerCase() !== o.token.toLowerCase()) {
      throw new Error(`The bridge manifest's token ${manifest.l2.token.address} is not the token sold (${o.token}).`);
    }
    await registerSponsor(wallet, manifest);
    await registerBridgeContracts(wallet, manifest);
    split = await SplitMerchant.create({
      manifest,
      l1: createPublicClient({ transport: http(o.l1RpcUrl) }),
      node,
      wallet,
      merchant: address,
      finalizedAbove: o.finalizedAbove,
      log,
    });
    log(
      split.listingTime === undefined
        ? "Split payments: on, but this merchant's listing is not found yet; they are offered once it is."
        : `Split payments: on (listing landed at ${new Date(Number(split.listingTime) * 1000).toISOString()}).`,
    );
  }

  const signer = new AztecFacilitatorSigner(account, node, tokens, split);
  // Fail now, not at the first buyer, if this account may not charge in the token.
  await signer.assertCanSell(o.token);
  const facilitator = new ExactAztecFacilitatorScheme(signer, [network.caip2]);
  await facilitator.initialize();

  const store = o.store ?? sqliteStateStore(join(dataDir, STORE_FILE));
  const { secret, source } = resolveRefSecret({ secret: o.secret, dataDir, secretKey: o.keys.secretKey, address });
  if (source === "file") log(`Reference secret: ${LEGACY_SECRET_FILE} in the data folder.`);

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
    consolidateEveryMs: o.consolidateEveryMs,
    claimPollMs: o.claimPollMs,
    leaseMs: o.leaseMs,
    log,
  });
  await jobs.start();

  let modes: PaymentMode[] = ["commitment"];
  if (token.kind === "inference-money") modes = split ? ["ref", "split", "commitment"] : ["ref", "commitment"];

  let stopped: Promise<void> | undefined;
  let removeSignals = () => {};
  const stop = () =>
    (stopped ??= (async () => {
      removeSignals();
      await jobs.stop();
      store.close?.();
    })());
  if (o.handleSignals ?? true) removeSignals = stopOnSignals(stop, process, log);

  const defaults = { network: network.caip2, asset: o.token, payTo: address.toString(), modes };
  const routes = (r: Record<string, MerchantRoute>) => merchantRoutes(r, defaults);
  return {
    address,
    network,
    dataDir,
    node,
    wallet,
    tokens,
    token,
    modes,
    signer,
    facilitator,
    split,
    store,
    secret,
    jobs,
    routes,
    middleware: (r, config = {}) => createPaymentMiddleware(routes(r), { ...config, facilitator, store, secret }),
    status: () => jobs.status(),
    stop,
  };
}
