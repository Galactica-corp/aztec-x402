/**
 * A {@link PaymentStateStore} in a SQLite file, through `node:sqlite`, which
 * Node (22.13 and later) and Bun both provide.
 *
 * Several processes on one host may share the file: it runs in WAL mode with
 * a busy timeout, and serving a reference is one `INSERT … ON CONFLICT DO
 * NOTHING`, so exactly one caller wins. It is not a store for servers on
 * several hosts (SQLite over a network filesystem is not safe); give those a
 * `PaymentStateStore` on a shared database.
 *
 * The file holds payment proofs and split salts: it is created readable by
 * its owner only, and must be backed up with the merchant's wallet.
 */
import { closeSync, existsSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  MAX_PROOFS_PER_REF,
  type PaymentStateStore,
  type SplitClaimStatus,
  type StoredProof,
  type StoredSplitClaim,
} from "@galactica-net/x402-core";
import { payloadDigest } from "./memory.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS proofs (
  payment_ref TEXT NOT NULL,
  digest TEXT NOT NULL,
  nonce TEXT NOT NULL,
  mode TEXT NOT NULL,
  asset TEXT NOT NULL,
  payload TEXT NOT NULL,
  price TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (payment_ref, digest)
);
CREATE INDEX IF NOT EXISTS proofs_received ON proofs (received_at);
CREATE TABLE IF NOT EXISTS taken_in (
  payment_ref TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS served (
  payment_ref TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  served_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS served_at ON served (served_at);
CREATE TABLE IF NOT EXISTS split_claims (
  payment_ref TEXT PRIMARY KEY,
  asset TEXT NOT NULL,
  claim TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_try_at INTEGER NOT NULL,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
`;

const int = z.union([z.number(), z.bigint()]).transform(Number);

const ProofRowSchema = z.object({
  payment_ref: z.string(),
  nonce: z.string(),
  mode: z.enum(["ref", "split"]),
  asset: z.string(),
  payload: z.string(),
  price: z.string(),
  received_at: int,
});

const ClaimRowSchema = z.object({
  payment_ref: z.string(),
  asset: z.string(),
  claim: z.string(),
  status: z.enum(["pending", "claimed", "consumed-unknown", "failed"]),
  attempts: int,
  next_try_at: int,
  last_error: z.string().nullable(),
  updated_at: int,
});

const CountSchema = z.object({ n: int });

const toClaim = (r: z.infer<typeof ClaimRowSchema>): StoredSplitClaim => ({
  paymentRef: r.payment_ref,
  asset: r.asset,
  claim: r.claim,
  status: r.status,
  attempts: r.attempts,
  nextTryAt: r.next_try_at,
  ...(r.last_error ? { lastError: r.last_error } : {}),
  updatedAt: r.updated_at,
});

export interface SqliteStateStoreOptions {
  /** How long a writer waits for another process's lock, in ms (default 5000). */
  busyTimeoutMs?: number;
}

export function sqliteStateStore(path: string, opts: SqliteStateStoreOptions = {}): PaymentStateStore {
  // Created before SQLite opens it, so it never exists readable by others; an empty file is an empty database.
  if (path !== ":memory:" && !existsSync(path)) closeSync(openSync(path, "wx", 0o600));
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${Math.trunc(opts.busyTimeoutMs ?? 5000)}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec(SCHEMA);

  const q = {
    proofExists: db.prepare("SELECT 1 FROM proofs WHERE payment_ref = ? AND digest = ?"),
    proofCount: db.prepare("SELECT COUNT(*) AS n FROM proofs WHERE payment_ref = ?"),
    insertProof: db.prepare(
      `INSERT INTO proofs (payment_ref, digest, nonce, mode, asset, payload, price, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    ),
    markTakenIn: db.prepare("INSERT INTO taken_in (payment_ref, at) VALUES (?, ?) ON CONFLICT DO NOTHING"),
    notTakenIn: db.prepare(
      `SELECT p.* FROM proofs p WHERE p.mode = 'ref' AND p.received_at >= ?
       AND NOT EXISTS (SELECT 1 FROM taken_in t WHERE t.payment_ref = p.payment_ref)
       ORDER BY p.received_at`,
    ),
    markServed: db.prepare("INSERT INTO served (payment_ref, nonce, served_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING"),
    isServed: db.prepare("SELECT 1 FROM served WHERE payment_ref = ?"),
    insertClaim: db.prepare(
      `INSERT INTO split_claims (payment_ref, asset, claim, status, attempts, next_try_at, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    ),
    claim: db.prepare("SELECT * FROM split_claims WHERE payment_ref = ?"),
    updateClaim: db.prepare(
      "UPDATE split_claims SET claim = ?, status = ?, attempts = ?, next_try_at = ?, last_error = ?, updated_at = ? WHERE payment_ref = ?",
    ),
    claims: db.prepare("SELECT * FROM split_claims ORDER BY updated_at"),
    claimsByStatus: db.prepare("SELECT * FROM split_claims WHERE status = ? ORDER BY updated_at"),
    sweepServed: db.prepare("DELETE FROM served WHERE served_at < ?"),
    sweepProofs: db.prepare("DELETE FROM proofs WHERE received_at < ?"),
    sweepTaken: db.prepare("DELETE FROM taken_in WHERE payment_ref NOT IN (SELECT payment_ref FROM proofs)"),
  };

  /** Runs `fn` in one write transaction: the lock is taken at BEGIN, so a check and its write cannot interleave with another process. */
  function immediate<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    async saveProof(p: StoredProof) {
      const digest = payloadDigest(p.payload);
      return immediate(() => {
        if (q.proofExists.get(p.paymentRef, digest)) return true;
        const { n } = CountSchema.parse(q.proofCount.get(p.paymentRef));
        if (n >= MAX_PROOFS_PER_REF) return false;
        q.insertProof.run(p.paymentRef, digest, p.nonce, p.mode, p.asset, p.payload, p.price, p.receivedAt);
        if (p.takenIn) q.markTakenIn.run(p.paymentRef, Date.now());
        return true;
      });
    },
    async markTakenIn(paymentRef) {
      q.markTakenIn.run(paymentRef, Date.now());
    },
    async proofsNotTakenIn(since) {
      return z.array(ProofRowSchema).parse(q.notTakenIn.all(since)).map((r) => ({
        paymentRef: r.payment_ref,
        nonce: r.nonce,
        mode: r.mode,
        asset: r.asset,
        payload: r.payload,
        price: r.price,
        receivedAt: r.received_at,
        takenIn: false,
      }));
    },
    async markServed(paymentRef, nonce) {
      return Number(q.markServed.run(paymentRef, nonce, Date.now()).changes) === 1;
    },
    async isServed(paymentRef) {
      return q.isServed.get(paymentRef) !== undefined;
    },
    async saveSplitClaim(c) {
      q.insertClaim.run(c.paymentRef, c.asset, c.claim, c.status, c.attempts, c.nextTryAt, c.lastError ?? null, c.updatedAt);
    },
    async updateSplitClaim(paymentRef, patch) {
      immediate(() => {
        const row = q.claim.get(paymentRef);
        if (!row) return;
        const c = { ...toClaim(ClaimRowSchema.parse(row)), ...patch };
        q.updateClaim.run(c.claim, c.status, c.attempts, c.nextTryAt, c.lastError ?? null, Date.now(), paymentRef);
      });
    },
    async splitClaims(status?: SplitClaimStatus) {
      const rows = status ? q.claimsByStatus.all(status) : q.claims.all();
      return z.array(ClaimRowSchema).parse(rows).map(toClaim);
    },
    async sweep(before) {
      return immediate(() => {
        const served = Number(q.sweepServed.run(before).changes);
        const proofs = Number(q.sweepProofs.run(before).changes);
        q.sweepTaken.run();
        return served + proofs;
      });
    },
    close() {
      db.close();
    },
  };
}
