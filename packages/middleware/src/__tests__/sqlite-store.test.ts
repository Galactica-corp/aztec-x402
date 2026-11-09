import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaymentStateStore, StoredProof, StoredSplitClaim } from "@galactica-net/x402-core";
import { memoryStateStore } from "../store/memory.js";
import { sqliteStateStore } from "../store/sqlite.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function file(): string {
  const dir = mkdtempSync(join(tmpdir(), "x402-store-"));
  dirs.push(dir);
  return join(dir, "state.sqlite");
}

const proof = (over: Partial<StoredProof> = {}): StoredProof => ({
  paymentRef: "0xref",
  nonce: "n",
  mode: "ref",
  asset: "0xtoken",
  payload: '{"p":1}',
  price: "10",
  receivedAt: 1_000,
  takenIn: false,
  ...over,
});

const claim: StoredSplitClaim = { paymentRef: "0xref", asset: "0xtoken", claim: "{}", status: "pending", attempts: 0, nextTryAt: 0, updatedAt: 0 };

const stores: Array<[string, () => PaymentStateStore]> = [
  ["memory", () => memoryStateStore()],
  ["sqlite", () => sqliteStateStore(file())],
];
for (const [name, make] of stores) {
  describe(`${name} store`, () => {
    it("stores each distinct proof once, up to the cap, and replays those not taken in", async () => {
      const s = make();
      expect(await s.saveProof(proof())).toBe(true);
      expect(await s.saveProof(proof())).toBe(true);
      for (let i = 2; i <= 8; i++) expect(await s.saveProof(proof({ payload: `{"p":${i}}` }))).toBe(true);
      expect(await s.saveProof(proof({ payload: '{"p":9}' }))).toBe(false);
      expect(await s.proofsNotTakenIn(0)).toHaveLength(8);
      expect(await s.proofsNotTakenIn(2_000)).toHaveLength(0);
      await s.markTakenIn("0xref");
      expect(await s.proofsNotTakenIn(0)).toHaveLength(0);
      s.close?.();
    });

    it("never replays split proofs", async () => {
      const s = make();
      await s.saveProof(proof({ mode: "split" }));
      expect(await s.proofsNotTakenIn(0)).toHaveLength(0);
      s.close?.();
    });

    it("serves a reference once", async () => {
      const s = make();
      expect(await s.isServed("0xref")).toBe(false);
      expect(await s.markServed("0xref", "n")).toBe(true);
      expect(await s.markServed("0xref", "n2")).toBe(false);
      expect(await s.isServed("0xref")).toBe(true);
      s.close?.();
    });

    it("keeps the first split claim and updates its status", async () => {
      const s = make();
      await s.saveSplitClaim(claim);
      await s.saveSplitClaim({ ...claim, claim: '{"other":1}' });
      await s.updateSplitClaim("0xref", { attempts: 2, lastError: "sponsor busy", nextTryAt: 5 });
      expect(await s.splitClaims("pending")).toMatchObject([{ claim: "{}", attempts: 2, lastError: "sponsor busy", nextTryAt: 5 }]);
      await s.updateSplitClaim("0xref", { status: "claimed" });
      expect(await s.splitClaims("pending")).toHaveLength(0);
      expect(await s.splitClaims()).toHaveLength(1);
      s.close?.();
    });

    it("sweeps old proofs and served marks, never claims", async () => {
      const s = make();
      await s.saveProof(proof({ receivedAt: 1 }));
      await s.saveProof(proof({ paymentRef: "0xnew", receivedAt: Date.now() }));
      await s.markServed("0xref", "n");
      await s.saveSplitClaim(claim);
      const removed = await s.sweep(Date.now() + 1_000);
      expect(removed).toBeGreaterThanOrEqual(3);
      expect(await s.isServed("0xref")).toBe(false);
      expect(await s.proofsNotTakenIn(0)).toHaveLength(0);
      expect(await s.splitClaims()).toHaveLength(1);
      s.close?.();
    });
  });
}

describe("sqlite store file", () => {
  it("is readable by its owner only", () => {
    const path = file();
    sqliteStateStore(path).close?.();
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  it("lets exactly one of two connections serve a reference", async () => {
    const path = file();
    const a = sqliteStateStore(path);
    const b = sqliteStateStore(path);
    const results = await Promise.all([a.markServed("0xr", "1"), b.markServed("0xr", "2"), a.markServed("0xr", "3")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await b.isServed("0xr")).toBe(true);
    a.close?.();
    b.close?.();
  });
});
