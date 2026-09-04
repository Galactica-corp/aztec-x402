/**
 * Wallet management — key generation, persistence, account deployment, and wallet loading.
 *
 * Sandbox / local-network: prefer Aztec's genesis-funded test accounts (no account-deploy
 * tx). Testnet / remote: generate Schnorr keys and deploy account contracts, paying fees
 * with Sponsored FPC when configured.
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
import { getInitialTestAccountsData } from "@aztec/accounts/testing";
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

function keySetFromTestAccount(account: {
  secret: Fr;
  signingKey: GrumpkinScalar;
  salt: Fr;
  address: { toString(): string };
}): KeySet {
  return {
    secretKey: account.secret.toString(),
    signingKey: account.signingKey.toString(),
    salt: account.salt.toString(),
    address: account.address.toString(),
  };
}

/** True when keys match a local-network genesis test account (initializerless). */
async function isGenesisTestAccount(k: KeySet): Promise<boolean> {
  const accounts = await getInitialTestAccountsData();
  return accounts.some(
    (a) =>
      a.secret.toString() === k.secretKey &&
      a.salt.toString() === k.salt &&
      a.signingKey.toString() === k.signingKey,
  );
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
 * Ensure Alice/Bob keys exist.
 *
 * - Sandbox: always use the local network's genesis test accounts.
 * - Remote: load keys.json or generate fresh deployable Schnorr keys.
 */
export async function ensureKeys(
  keysPath: string,
  wallet: PXEWallet,
  opts?: { useSandboxTestAccounts?: boolean },
): Promise<StoredKeys> {
  if (opts?.useSandboxTestAccounts) {
    console.log("Using local-network genesis test accounts...");
    const [aliceData, bobData] = await getInitialTestAccountsData();
    if (!aliceData || !bobData) {
      throw new Error("Expected at least 2 initial test accounts from @aztec/accounts/testing");
    }
    const keys: StoredKeys = {
      alice: keySetFromTestAccount(aliceData),
      bob: keySetFromTestAccount(bobData),
    };
    writeFileSync(keysPath, JSON.stringify(keys, null, 2));
    console.log(`  Alice: ${keys.alice.address}`);
    console.log(`  Bob:   ${keys.bob.address}`);
    console.log(`Keys saved to ${keysPath}\n`);
    return keys;
  }

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
 * Register the canonical Sponsored FPC in the wallet and return a payment method.
 *
 * Same address local-network prints at startup (`SponsoredFPC: 0x1441…`) and that
 * `@aztec/aztec`'s `registerDeployedSponsoredFPCInWalletAndGetAddress` derives via
 * `SPONSORED_FPC_SALT`. Use when `USE_SPONSORED_FPC=true`.
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

async function createAccountFromKeys(
  wallet: PXEWallet,
  keys: StoredKeys,
  who: "alice" | "bob",
): Promise<AccountManager> {
  const k = keys[who];
  const secretKey = Fr.fromString(k.secretKey);
  const signingKey = GrumpkinScalar.fromString(k.signingKey);
  const salt = Fr.fromString(k.salt);
  // Genesis test accounts use the initializerless Schnorr contract; same keys with
  // createSchnorrAccount would derive a different address.
  if (await isGenesisTestAccount(k)) {
    return wallet.createSchnorrInitializerlessAccount(secretKey, salt, signingKey);
  }
  return wallet.createSchnorrAccount(secretKey, salt, signingKey);
}

/**
 * Register genesis test accounts (sandbox) or deploy Schnorr accounts (remote).
 *
 * Genesis accounts need no deploy tx. Remote deploys use `NO_FROM` + Sponsored FPC.
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
    const account = await createAccountFromKeys(wallet, keys, name);
    const genesis = await isGenesisTestAccount(k);

    if (account.address.toString() !== k.address) {
      console.log(
        `  ${name}: keys.json address ${k.address} != derived ${account.address} — updating keys.`,
      );
      k.address = account.address.toString();
    }

    if (genesis) {
      console.log(`  ${name} registered (genesis-funded) at ${account.address}`);
    } else {
      const onChain = await node.getContract(account.address);
      if (onChain) {
        console.log(`  ${name} already deployed on-chain — skipping.`);
      } else {
        console.log(`  Deploying ${name} account...`);
        try {
          const deployMethod = await account.getDeployMethod();
          await deployMethod.send({
            from: NO_FROM,
            wait: { timeout, waitForStatus: TxStatus.CHECKPOINTED },
            fee: opts?.paymentMethod ? { paymentMethod: opts.paymentMethod } : undefined,
          });
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
  return createAccountFromKeys(wallet, keys, who);
}
