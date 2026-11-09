/**
 * A {@link PaymentStateStore} in process memory: for tests and throwaway
 * demos only. Everything it holds is lost with the process, including proofs
 * that are the only copy of a payment.
 */
import { createHash } from "node:crypto";
import {
  MAX_PROOFS_PER_REF,
  type PaymentStateStore,
  type SplitClaimStatus,
  type StoredProof,
  type StoredSplitClaim,
} from "@galactica-net/x402-core";

export const payloadDigest = (payload: string): string => createHash("sha256").update(payload).digest("hex");

export function memoryStateStore(): PaymentStateStore {
  const proofs = new Map<string, Map<string, StoredProof>>();
  const taken = new Set<string>();
  const served = new Map<string, { nonce: string; at: number }>();
  const claims = new Map<string, StoredSplitClaim>();

  return {
    async saveProof(proof) {
      let forRef = proofs.get(proof.paymentRef);
      if (!forRef) proofs.set(proof.paymentRef, (forRef = new Map()));
      const key = payloadDigest(proof.payload);
      if (forRef.has(key)) return true;
      if (forRef.size >= MAX_PROOFS_PER_REF) return false;
      forRef.set(key, { ...proof });
      return true;
    },
    async markTakenIn(paymentRef) {
      taken.add(paymentRef);
    },
    async proofsNotTakenIn(since) {
      const out: StoredProof[] = [];
      for (const [ref, forRef] of proofs) {
        if (taken.has(ref)) continue;
        for (const p of forRef.values()) if (p.mode === "ref" && p.receivedAt >= since) out.push({ ...p, takenIn: false });
      }
      return out;
    },
    async markServed(paymentRef, nonce) {
      if (served.has(paymentRef)) return false;
      served.set(paymentRef, { nonce, at: Date.now() });
      return true;
    },
    async isServed(paymentRef) {
      return served.has(paymentRef);
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
