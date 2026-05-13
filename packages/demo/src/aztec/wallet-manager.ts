/**
 * Wallet management — key generation, persistence, account deployment, and wallet loading.
 *
 * Replaces sandbox-only `getDeployedTestAccountsWallets` with programmatic
 * Schnorr wallet creation that works on sandbox, devnet, and testnet.
 *
 * Uses PXEWallet (see pxe-wallet.ts) instead of EmbeddedWallet directly.
 * EmbeddedWallet's stub-account simulation causes commitment mismatches
 * in the partial note flow — see pxe-wallet.ts for details.
 */
import { Fr, GrumpkinScalar } from "@aztec/aztec.js/fields";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";
import { getContractInstanceFromInstantiationParams } from "@aztec/aztec.js/contracts";
import { SponsoredFPCContractArtifact } from "@aztec/noir-contracts.js/SponsoredFPC";
import { SPONSORED_FPC_SALT } from "@aztec/constants";
import { NO_FROM } from "@aztec/aztec.js/account";
import { TxStatus } from "@aztec/aztec.js/tx";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { PXEWallet } from "./pxe-wallet.js";
import type { AccountManager } from "@aztec/aztec.js/wallet";
import { readFileSync, writeFileSync, existsSync } from "fs";

export interface KeySet {
  secretKey: string;
  signingKey: string;
  salt: string;
  address: string;
}

export interface StoredKeys {
  alice: KeySet;
  bob: KeySet;
}

async function createKeySet(
  wallet: PXEWallet,
  name: "alice" | "bob",
): Promise<KeySet> {
  const secretKey = Fr.random();
  const signingKey = GrumpkinScalar.random();
  const salt = Fr.random();
  const account = await wallet.createSchnorrAccount(secretKey, salt, signingKey);
  const address = account.address;

  console.log(`  ${name}: ${address}`);
  return {
    secretKey: secretKey.toString(),
    signingKey: signingKey.toString(),
    salt: salt.toString(),
    address: address.toString(),
  };
}

/**
 * Load keys.json synchronously. Throws with a clear error if missing.
 */
export function loadKeys(keysPath: string): StoredKeys {
  if (!existsSync(keysPath)) {
    throw new Error(
      `keys.json not found at ${keysPath}. Run setup first:\n  bun run packages/demo/src/aztec/setup.ts`,
    );
  }
  return JSON.parse(readFileSync(keysPath, "utf-8"));
}

/**
 * If keys.json exists, load it. Otherwise generate fresh keys, save, and return.
 */
export async function ensureKeys(keysPath: string, wallet: PXEWallet): Promise<StoredKeys> {
  if (existsSync(keysPath)) {
    console.log("Loading existing keys from keys.json...");
    return loadKeys(keysPath);
  }

  console.log("Generating fresh Schnorr account keys...");
  const keys: StoredKeys = {
    alice: await createKeySet(wallet, "alice"),
    bob: await createKeySet(wallet, "bob"),
  };

  writeFileSync(keysPath, JSON.stringify(keys, null, 2));
  console.log(`Keys saved to ${keysPath}\n`);
  return keys;
}

/**
 * Register the Sponsored FPC contract and return a payment method.
 * On sandbox (no sponsoredFPC), returns undefined.
 */
export async function setupSponsoredPayment(
  wallet: PXEWallet,
): Promise<SponsoredFeePaymentMethod> {
  const sponsoredFPC = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContractArtifact,
    { salt: new Fr(SPONSORED_FPC_SALT) },
  );
  await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact);
  return new SponsoredFeePaymentMethod(sponsoredFPC.address);
}

/**
 * Deploy (or reconnect to) both Alice and Bob accounts.
 * Checks on-chain (via the node) whether the account contract is already deployed.
 *
 * On devnet, pass a `paymentMethod` (Sponsored FPC) to pay deployment gas.
 * On sandbox, fees are zero — pass undefined.
 */
export async function deployAccounts(
  wallet: PXEWallet,
  node: AztecNode,
  keys: StoredKeys,
  opts?: { paymentMethod?: SponsoredFeePaymentMethod; timeout?: number },
): Promise<{ aliceAccount: AccountManager; bobAccount: AccountManager }> {
  let aliceAccount: AccountManager | undefined;
  let bobAccount: AccountManager | undefined;
  const timeout = opts?.timeout ?? 240;

  for (const name of ["alice", "bob"] as const) {
    const k = keys[name];
    const secretKey = Fr.fromString(k.secretKey);
    const signingKey = GrumpkinScalar.fromString(k.signingKey);
    const salt = Fr.fromString(k.salt);
    const account = await wallet.createSchnorrAccount(secretKey, salt, signingKey);

    // Check if the account contract is deployed on-chain
    const onChain = await node.getContract(account.address);
    if (onChain) {
      console.log(`  ${name} already deployed on-chain — skipping.`);
    } else {
      console.log(`  Deploying ${name} account...`);
      try {
        const deployMethod = await account.getDeployMethod();
        const sendOpts: Record<string, unknown> = {
          from: NO_FROM,
          wait: { timeout, waitForStatus: TxStatus.CHECKPOINTED },
        };
        if (opts?.paymentMethod) {
          sendOpts.fee = { paymentMethod: opts.paymentMethod };
        }
        await deployMethod.send(sendOpts);
        console.log(`  ${name} deployed at ${account.address}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("nullifier") || msg.includes("already deployed")) {
          console.log(`  ${name} already deployed (caught duplicate) — continuing.`);
        } else {
          throw err;
        }
      }
    }

    if (name === "alice") {
      aliceAccount = account;
    } else {
      bobAccount = account;
    }
  }

  if (!aliceAccount || !bobAccount) {
    throw new Error("Failed to load Alice and Bob accounts");
  }

  return { aliceAccount, bobAccount };
}

/**
 * Load an account for an already-registered account (no deployment).
 */
export async function loadAccount(
  wallet: PXEWallet,
  keys: StoredKeys,
  who: "alice" | "bob",
): Promise<AccountManager> {
  const k = keys[who];
  const secretKey = Fr.fromString(k.secretKey);
  const signingKey = GrumpkinScalar.fromString(k.signingKey);
  const salt = Fr.fromString(k.salt);
  return wallet.createSchnorrAccount(secretKey, salt, signingKey);
}
