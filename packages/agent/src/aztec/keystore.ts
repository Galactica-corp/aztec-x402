/**
 * Account key file for the agent's Aztec account.
 *
 * The file is created with mode 0600 inside a 0700 directory and is never
 * printed by the CLI. Losing it loses the funds; there is no recovery.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { Fr, GrumpkinScalar } from "@aztec-labs/aztec.js/fields";

export interface AccountKeys {
  /** Account contract flavour; initializerless accounts need no deploy tx. */
  type: "schnorr_initializerless";
  secretKey: string;
  signingKey: string;
  salt: string;
  address: string;
  createdAt: string;
}

export function accountKeysPath(dataDir: string): string {
  return join(dataDir, "account.json");
}

export function loadAccountKeys(dataDir: string): AccountKeys | undefined {
  const path = accountKeysPath(dataDir);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function generateAccountSecrets(): Omit<AccountKeys, "address" | "createdAt" | "type"> {
  return {
    secretKey: Fr.random().toString(),
    signingKey: GrumpkinScalar.random().toString(),
    salt: Fr.random().toString(),
  };
}

export function saveAccountKeys(dataDir: string, keys: AccountKeys): void {
  const path = accountKeysPath(dataDir);
  // `wx` refuses to overwrite: an existing key file may hold funds.
  writeFileSync(path, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}
