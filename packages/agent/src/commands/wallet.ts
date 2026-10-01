import { accountFromKeys, openWallet } from "../aztec/session.js";
import {
  accountKeysPath,
  generateAccountSecrets,
  loadAccountKeys,
  saveAccountKeys,
} from "../aztec/keystore.js";
import type { ResolvedContext } from "../config.js";
import { UsageError } from "../errors.js";

/**
 * Create the agent's Aztec account, or report the existing one.
 *
 * Accounts are initializerless Schnorr: the address is derived from the keys
 * and the account can send its first transaction (fees via Sponsored FPC on
 * testnet) without a separate deployment.
 */
export async function walletCreate(ctx: ResolvedContext) {
  const existing = loadAccountKeys(ctx.dataDir);
  if (existing) {
    return {
      created: false,
      network: ctx.network.name,
      address: existing.address,
      keyFile: accountKeysPath(ctx.dataDir),
    };
  }

  const { wallet } = await openWallet(ctx.network, ctx.dataDir);
  const secrets = generateAccountSecrets();
  const account = await accountFromKeys(wallet, secrets);
  saveAccountKeys(ctx.dataDir, {
    type: "schnorr_initializerless",
    ...secrets,
    address: account.address.toString(),
    createdAt: new Date().toISOString(),
  });

  return {
    created: true,
    network: ctx.network.name,
    address: account.address.toString(),
    keyFile: accountKeysPath(ctx.dataDir),
  };
}

export function walletShow(ctx: ResolvedContext) {
  const keys = loadAccountKeys(ctx.dataDir);
  if (!keys) {
    throw new UsageError(
      `No agent wallet for network "${ctx.network.name}". Run \`aztec-x402 wallet create\`.`,
      "no_wallet",
    );
  }
  return {
    network: ctx.network.name,
    address: keys.address,
    keyFile: accountKeysPath(ctx.dataDir),
    createdAt: keys.createdAt,
  };
}
