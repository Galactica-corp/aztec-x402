/**
 * Payments made but not yet acknowledged by the merchant, kept so they can be
 * delivered again (`pay --resume <id>`).
 *
 * A `ref` payment's proof carries the only copy of the merchant's note: if it
 * is lost before the merchant has it, the money is spent and the merchant can
 * never serve. So it is written here the moment the payment returns, before it
 * is sent, and kept until the merchant answers 2xx. Each file is 0600.
 *
 * Resending helps only while the merchant has not served the payment. Once it
 * has, it refuses the same payment again (a reference is served once), even
 * when its response never arrived; the payment is then closed here.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import type { PaymentPayload } from "@galactica-net/x402-mechanism";
import { UsageError } from "./errors.js";

export interface StoredPayment {
  id: string;
  url: string;
  request: { method: string; headers: Record<string, string>; body?: string };
  /** The full payment payload, sent unchanged on every delivery. */
  payload: PaymentPayload;
  createdAt: string;
  /** Set once the merchant answered 2xx. */
  acknowledgedAt?: string;
  /** Set when the merchant had served the payment but its response was lost: it cannot be delivered again. */
  responseLostAt?: string;
  /** Set when the merchant served another payment under the same reference instead: this one is never served. */
  supersededAt?: string;
}

const dir = (dataDir: string) => join(dataDir, "proofs");
const file = (dataDir: string, id: string) => {
  if (!/^[0-9a-zA-Z-]+$/.test(id)) throw new UsageError(`Not a payment id: ${id}`);
  return join(dir(dataDir), `${id}.json`);
};

export function saveStoredPayment(dataDir: string, p: StoredPayment): void {
  mkdirSync(dir(dataDir), { recursive: true, mode: 0o700 });
  const path = file(dataDir, p.id);
  // Write-then-rename: a crash leaves either the old file or the new one, never half of it.
  writeFileSync(`${path}.tmp`, JSON.stringify(p, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function readStoredPayment(dataDir: string, id: string): StoredPayment {
  const path = file(dataDir, id);
  if (!existsSync(path)) throw new UsageError(`No stored payment with id ${id}.`, "not_found");
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function acknowledgeStoredPayment(dataDir: string, id: string): void {
  saveStoredPayment(dataDir, { ...readStoredPayment(dataDir, id), acknowledgedAt: new Date().toISOString() });
}

export function markResponseLost(dataDir: string, id: string): void {
  saveStoredPayment(dataDir, { ...readStoredPayment(dataDir, id), responseLostAt: new Date().toISOString() });
}

export function markSuperseded(dataDir: string, id: string): void {
  saveStoredPayment(dataDir, { ...readStoredPayment(dataDir, id), supersededAt: new Date().toISOString() });
}

/** Payments that may still be delivered (not acknowledged, not closed), oldest first. */
export function unacknowledgedPayments(dataDir: string): StoredPayment[] {
  if (!existsSync(dir(dataDir))) return [];
  return readdirSync(dir(dataDir))
    .filter((f) => f.endsWith(".json"))
    .map((f): StoredPayment => JSON.parse(readFileSync(join(dir(dataDir), f), "utf-8")))
    .filter((p) => !p.acknowledgedAt && !p.responseLostAt && !p.supersededAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
