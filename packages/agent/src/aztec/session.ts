/**
 * An open wallet session: node client, persistent PXE, the agent's account,
 * and fee payment. Every command that touches private state goes through here.
 */
import type { AztecNode } from "@aztec-labs/aztec.js/node";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr, GrumpkinScalar } from "@aztec-labs/aztec.js/fields";
import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee";
import { getContractInstanceFromInstantiationParams } from "@aztec-labs/aztec.js/contracts";
import { TxStatus } from "@aztec-labs/aztec.js/tx";
import type { AccountManager } from "@aztec-labs/aztec.js/wallet";
import type { PaymentGate } from "@galactica-net/inference-money-core";
import { SponsoredFPCContractArtifact } from "@aztec-labs/noir-contracts.js/SponsoredFPC";
import { SPONSORED_FPC_SALT } from "@aztec-labs/constants";
import { join } from "path";
import { createNodeClient } from "./node-client.js";
import { createPXEWallet, type PXEWallet } from "./pxe-wallet.js";
import { loadAccountKeys, type AccountKeys } from "./keystore.js";
import type { NetworkConfig } from "../networks.js";
import { NodeUnreachableError, UsageError } from "../errors.js";
import { assertNodeVersion } from "./node-version.js";
import type { TokenAdapter } from "./tokens/adapter.js";
import { filePaymentStore } from "./tokens/payment-store.js";
import { paymentGateFor, TokenRegistry } from "./tokens/registry.js";

/** Long enough for client-side proving plus a checkpointed block on testnet. */
export const TX_TIMEOUT_SECONDS = 300;

export interface Session {
  network: NetworkConfig;
  node: AztecNode;
  wallet: PXEWallet;
  account: AccountManager;
  address: AztecAddress;
  /** The tokens this account holds or pays with, by address. */
  tokens: TokenRegistry;
  /** Options every `send()` needs: sender, fee payment, and how long to wait. */
  sendOpts: {
    from: AztecAddress;
    fee?: { paymentMethod: SponsoredFeePaymentMethod };
    wait: { timeout: number; waitForStatus: TxStatus };
  };
  fee?: { paymentMethod: SponsoredFeePaymentMethod };
}

export interface SessionOptions {
  /**
   * Address of the token this session will pay with. Some kinds need the
   * wallet built in a particular way (tokens/inference.ts), which can only be
   * done before it exists.
   */
  payingWith?: string;
}

export async function openWallet(network: NetworkConfig, dataDir: string, opts: SessionOptions = {}): Promise<{
  node: AztecNode;
  wallet: PXEWallet;
  paymentGate?: PaymentGate;
}> {
  const node = createNodeClient(network.nodeUrl);
  // Fail fast with a clear code: the PXE needs the node for everything, even key derivation.
  let info;
  try {
    info = await node.getNodeInfo();
  } catch (error) {
    throw new NodeUnreachableError(network.nodeUrl, error);
  }
  assertNodeVersion(info.nodeVersion, network.nodeUrl);
  const create = (walletNode: AztecNode) =>
    createPXEWallet(walletNode, {
      ephemeral: false,
      pxe: {
        proverEnabled: network.proverEnabled,
        dataDirectory: join(dataDir, "pxe"),
      },
    });
  const paymentGate = opts.payingWith
    ? await paymentGateFor(node, opts.payingWith, () => filePaymentStore(join(dataDir, "requests.json")))
    : undefined;
  const wallet = paymentGate ? await paymentGate.bindWallet(create) : await create(node);
  return { node, wallet, paymentGate };
}

export async function accountFromKeys(wallet: PXEWallet, keys: Omit<AccountKeys, "address" | "createdAt" | "type">) {
  return wallet.createSchnorrInitializerlessAccount(
    Fr.fromString(keys.secretKey),
    Fr.fromString(keys.salt),
    GrumpkinScalar.fromString(keys.signingKey),
  );
}

/** Register the canonical Sponsored FPC and return a payment method for it. */
export async function sponsoredFeePayment(wallet: PXEWallet): Promise<SponsoredFeePaymentMethod> {
  const sponsoredFPC = await getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  });
  await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact);
  return new SponsoredFeePaymentMethod(sponsoredFPC.address);
}

export async function openSession(
  network: NetworkConfig,
  dataDir: string,
  opts: SessionOptions = {},
): Promise<Session> {
  const keys = loadAccountKeys(dataDir);
  if (!keys) {
    throw new UsageError(
      `No agent wallet for network "${network.name}". Run \`aztec-x402 wallet create\` first.`,
      "no_wallet",
    );
  }
  const { node, wallet, paymentGate } = await openWallet(network, dataDir, opts);
  const account = await accountFromKeys(wallet, keys);
  const address = account.address;
  if (address.toString() !== keys.address) {
    throw new Error(`Key file address ${keys.address} does not match derived address ${address}`);
  }

  const fee = network.sponsoredFees ? { paymentMethod: await sponsoredFeePayment(wallet) } : undefined;
  return {
    network,
    node,
    wallet,
    account,
    address,
    tokens: new TokenRegistry({ node, wallet, account: address, fee, paymentGate }),
    fee,
    sendOpts: {
      from: address,
      fee,
      wait: { timeout: TX_TIMEOUT_SECONDS, waitForStatus: TxStatus.CHECKPOINTED },
    },
  };
}

/** Identify a token contract, register it with the PXE (idempotent) and return its adapter. */
export function tokenAt(session: Pick<Session, "tokens">, address: string): Promise<TokenAdapter> {
  return session.tokens.get(address);
}
