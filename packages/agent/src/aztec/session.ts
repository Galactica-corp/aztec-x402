/**
 * An open wallet session: node client, persistent PXE, the agent's account,
 * and fee payment. Every command that touches private state goes through here.
 */
import { createAztecNodeClient, type AztecNode } from "@aztec/aztec.js/node";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr, GrumpkinScalar } from "@aztec/aztec.js/fields";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { getContractInstanceFromInstantiationParams } from "@aztec/aztec.js/contracts";
import { TxStatus } from "@aztec/aztec.js/tx";
import type { AccountManager } from "@aztec/aztec.js/wallet";
import { SponsoredFPCContractArtifact } from "@aztec/noir-contracts.js/SponsoredFPC";
import { SPONSORED_FPC_SALT } from "@aztec/constants";
import { TokenContract } from "@aztec-foundation/aztec-standards/dist/src/artifacts/Token.js";
import { join } from "path";
import { createPXEWallet, type PXEWallet } from "./pxe-wallet.js";
import { loadAccountKeys, type AccountKeys } from "./keystore.js";
import type { NetworkConfig } from "../networks.js";
import { UsageError } from "../errors.js";

/** Long enough for client-side proving plus a checkpointed block on testnet. */
export const TX_TIMEOUT_SECONDS = 300;

export interface Session {
  network: NetworkConfig;
  node: AztecNode;
  wallet: PXEWallet;
  account: AccountManager;
  address: AztecAddress;
  /** Options every `send()` needs: sender, fee payment, and how long to wait. */
  sendOpts: {
    from: AztecAddress;
    fee?: { paymentMethod: SponsoredFeePaymentMethod };
    wait: { timeout: number; waitForStatus: TxStatus };
  };
  fee?: { paymentMethod: SponsoredFeePaymentMethod };
}

export async function openWallet(network: NetworkConfig, dataDir: string): Promise<{
  node: AztecNode;
  wallet: PXEWallet;
}> {
  const node = createAztecNodeClient(network.nodeUrl);
  const wallet = await createPXEWallet(node, {
    ephemeral: false,
    pxe: {
      proverEnabled: network.proverEnabled,
      dataDirectory: join(dataDir, "pxe"),
    },
  });
  return { node, wallet };
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

export async function openSession(network: NetworkConfig, dataDir: string): Promise<Session> {
  const keys = loadAccountKeys(dataDir);
  if (!keys) {
    throw new UsageError(
      `No agent wallet for network "${network.name}". Run \`aztec-x402 wallet create\` first.`,
      "no_wallet",
    );
  }
  const { node, wallet } = await openWallet(network, dataDir);
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
    fee,
    sendOpts: {
      from: address,
      fee,
      wait: { timeout: TX_TIMEOUT_SECONDS, waitForStatus: TxStatus.CHECKPOINTED },
    },
  };
}

/** Register a token contract with the PXE (idempotent) and return a handle. */
export async function tokenAt(session: Pick<Session, "node" | "wallet">, address: string): Promise<TokenContract> {
  const tokenAddress = AztecAddress.fromStringUnsafe(address);
  const instance = await session.node.getContract(tokenAddress);
  if (!instance) {
    throw new UsageError(`Token contract ${address} is not deployed on this network.`, "token_not_found");
  }
  await session.wallet.registerContract(instance, TokenContract.artifact);
  return TokenContract.at(tokenAddress, session.wallet);
}
