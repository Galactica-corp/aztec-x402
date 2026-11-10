/**
 * A {@link PaymentStateStore} in process memory: for tests and throwaway
 * demos only. Everything it holds is lost with the process, including proofs
 * that are the only copy of a payment.
 */
import { createHash } from "node:crypto";
import {
  MAX_PROOFS_PER_REF,
  type PaymentStateStore,
  type ServedMark,
  type SplitClaimStatus,
  type StoredProof,
  type StoredSplitClaim,
} from "@galactica-net/x402-core";

export const payloadDigest = (payload: string): string => createHash("sha256").update(payload).digest("hex");

export function memoryStateStore(): PaymentStateStore {
  const proofs = new Map<string, Map<string, StoredProof>>();
  /** Reference → when its payment was taken in. */
  const taken = new Map<string, number>();
  const served = new Map<string, ServedMark>();
  const claims = new Map<string, StoredSplitClaim>();
  let consolidatedAt: number | undefined;
  const leases = new Map<string, { holder: string; expiresAt: number }>();

  return {
    async saveProof(proof) {
      let forRef = proofs.get(proof.paymentRef);
      if (!forRef) proofs.set(proof.paymentRef, (forRef = new Map()));
      const key = payloadDigest(proof.payload);
      if (forRef.has(key)) return true;
      if (forRef.size >= MAX_PROOFS_PER_REF) return false;
      forRef.set(key, { ...proof });
      if (proof.takenIn && !taken.has(proof.paymentRef)) taken.set(proof.paymentRef, Date.now());
      return true;
    },
    async markTakenIn(paymentRef) {
      if (!taken.has(paymentRef)) taken.set(paymentRef, Date.now());
    },
    async proofsNotTakenIn(since) {
      const out: StoredProof[] = [];
      for (const [ref, forRef] of proofs) {
        if (taken.has(ref)) continue;
        for (const p of forRef.values()) if (p.mode === "ref" && p.receivedAt >= since) out.push({ ...p, takenIn: false });
      }
      return out;
    },
    async takenInSince(since) {
      const since_ = [...taken.values()].filter((at) => at >= since);
      return since_.length === 0 ? { count: 0 } : { count: since_.length, oldestAt: Math.min(...since_) };
    },
    async refProofs(since) {
      const out: StoredProof[] = [];
      for (const [ref, forRef] of proofs) {
        for (const p of forRef.values()) if (p.mode === "ref" && p.receivedAt >= since) out.push({ ...p, takenIn: taken.has(ref) });
      }
      return out.sort((a, b) => a.receivedAt - b.receivedAt);
    },
    async consolidatedAt() {
      return consolidatedAt;
    },
    async markConsolidated(startedAt) {
      consolidatedAt = Math.max(consolidatedAt ?? 0, startedAt);
    },
    async acquireLease(name, holder, ttlMs, now) {
      const l = leases.get(name);
      if (l && l.holder !== holder && l.expiresAt > now) return false;
      leases.set(name, { holder, expiresAt: now + ttlMs });
      return true;
    },
    async releaseLease(name, holder) {
      if (leases.get(name)?.holder === holder) leases.delete(name);
    },
    async markServed(paymentRef, nonce, mark = {}) {
      if (served.has(paymentRef)) return false;
      served.set(paymentRef, { nonce, at: Date.now(), ...(mark.payment ? { payment: mark.payment.toLowerCase() } : {}) });
      if (mark.splitClaim) claims.set(paymentRef, { ...mark.splitClaim });
      return true;
    },
    async isServed(paymentRef) {
      return served.has(paymentRef);
    },
    async served(paymentRef) {
      const s = served.get(paymentRef);
      return s && { ...s };
    },
    async saveSplitClaim(claim) {
      if (!claims.has(claim.paymentRef)) claims.set(claim.paymentRef, { ...claim });
    },
    async updateSplitClaim(paymentRef, patch) {
      const c = claims.get(paymentRef);
      if (c) claims.set(paymentRef, { ...c, ...patch, updatedAt: Date.now() });
    },
    async splitClaims(status?: SplitClaimStatus) {
      return [...claims.values()].filter((c) => !status || c.status === status).map((c) => ({ ...c }));
    },
    async sweep(before) {
      let removed = 0;
      for (const [ref, s] of served) {
        if (s.at >= before) continue;
        served.delete(ref);
        removed++;
      }
      for (const [ref, forRef] of proofs) {
        for (const [key, p] of forRef) {
          if (p.receivedAt >= before) continue;
          forRef.delete(key);
          removed++;
        }
        if (forRef.size === 0) {
          proofs.delete(ref);
          taken.delete(ref);
        }
      }
      return removed;
    },
  };
}
