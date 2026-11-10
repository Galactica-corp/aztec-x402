/**
 * Durable server-side state for `ref` and `split` payments.
 *
 * References are not stored when issued: the middleware derives each from the
 * nonce and the quoted terms under a server secret, so a 402 writes nothing.
 * Rows appear only once a buyer presents a payment.
 *
 * A merchant must not lose what it learned from a buyer: a ref proof holds the
 * only copy of the merchant's note until the merchant consolidates, a split
 * claim holds the salt without which the price cannot be claimed, and a served
 * reference must stay served across restarts and every server instance.
 *
 * The interface is async so an implementation can sit on any database; the
 * middleware package ships an in-memory one (tests) and a SQLite one.
 */
import type { PaymentMode } from "./modes.js";

/** A proof a buyer presented, stored before the merchant acts on it. */
export interface StoredProof {
  paymentRef: string;
  nonce: string;
  mode: Exclude<PaymentMode, "commitment">;
  asset: string;
  /** The payment payload as JSON. */
  payload: string;
  price: string;
  receivedAt: number;
  /** Ref: the merchant's wallet holds the payment (`receivePayment` succeeded). */
  takenIn: boolean;
}

export type SplitClaimStatus = "pending" | "claimed" | "consumed-unknown" | "failed";

/** A verified split deposit the merchant still has to claim on Aztec. */
export interface StoredSplitClaim {
  paymentRef: string;
  asset: string;
  /** The SDK's `SplitClaim`, serialized by the merchant side. Holds the salt: keep the store private. */
  claim: string;
  status: SplitClaimStatus;
  attempts: number;
  /** Earliest time of the next attempt. */
  nextTryAt: number;
  lastError?: string;
  updatedAt: number;
}

/** Which payment a reference was served to. */
export interface ServedMark {
  nonce: string;
  /** The served payment's transaction hash (ref: Aztec, split: L1), lowercase. */
  payment?: string;
  at: number;
}

/**
 * Distinct proofs kept per reference: a buyer retries with the same one, so a
 * few cover every honest case. It bounds storage only; a caller must not
 * refuse a proof because the reference is full, since anyone who saw the 402
 * can fill it with junk.
 */
export const MAX_PROOFS_PER_REF = 8;

export interface PaymentStateStore {
  /**
   * Stores a presented proof. Every distinct payload of a reference is kept,
   * so a junk proof sent later never displaces the one that pays; an
   * identical one is stored once. False when the reference already holds
   * {@link MAX_PROOFS_PER_REF} distinct proofs (nothing stored); the caller
   * then verifies the proof without a stored copy.
   */
  saveProof(proof: StoredProof): Promise<boolean>;
  /** The payment of `paymentRef` is in the merchant's wallet: none of its proofs needs replaying. */
  markTakenIn(paymentRef: string): Promise<void>;
  /** Ref proofs not yet taken in, received at or after `since`: replayed on start. */
  proofsNotTakenIn(since: number): Promise<StoredProof[]>;
  /**
   * Payments taken in at or after `since`, and when the oldest was: notes that
   * exist only offchain until the next consolidation.
   */
  takenInSince(since: number): Promise<{ count: number; oldestAt?: number }>;
  /** Every ref proof received at or after `since`, taken in or not: taken in again before a consolidation. */
  refProofs(since: number): Promise<StoredProof[]>;

  /** When the last consolidation that succeeded started; undefined before the first. */
  consolidatedAt(): Promise<number | undefined>;
  /** Records a consolidation that succeeded, by the time it started: a payment taken in during it counts for the next. */
  markConsolidated(startedAt: number): Promise<void>;

  /**
   * Takes or renews the lease `name` for `holder` until `now + ttlMs`: true
   * when it is free, expired or already `holder`'s. Atomic across every user
   * of the store, so one of several server instances runs the background jobs.
   */
  acquireLease(name: string, holder: string, ttlMs: number, now: number): Promise<boolean>;
  /** Gives the lease up, if `holder` holds it. */
  releaseLease(name: string, holder: string): Promise<void>;

  /**
   * Marks the reference served to the payment `served.payment` identifies (its
   * transaction hash); false when the reference already was served, to any
   * payment. Atomic across every user of the store, together with the split
   * claim: a reference's stored claim is always the deposit it was served for.
   */
  markServed(paymentRef: string, nonce: string, served?: { payment?: string; splitClaim?: StoredSplitClaim }): Promise<boolean>;
  isServed(paymentRef: string): Promise<boolean>;
  /** The served mark of `paymentRef`; `payment` is absent on a mark written without one. */
  served(paymentRef: string): Promise<ServedMark | undefined>;

  /** Insert a split claim; a second save of one reference keeps the first. Outside tests, claims come with {@link markServed}. */
  saveSplitClaim(claim: StoredSplitClaim): Promise<void>;
  updateSplitClaim(
    paymentRef: string,
    patch: Partial<Pick<StoredSplitClaim, "claim" | "status" | "attempts" | "nextTryAt" | "lastError">>,
  ): Promise<void>;
  splitClaims(status?: SplitClaimStatus): Promise<StoredSplitClaim[]>;

  /**
   * Drops served marks and proofs received before `before`: a reference
   * older than its retention is refused before the store is asked, and a
   * proof older than the offchain-message lifetime can no longer be taken in.
   * Split claims are kept. Returns the rows removed.
   */
  sweep(before: number): Promise<number>;

  close?(): void;
}
