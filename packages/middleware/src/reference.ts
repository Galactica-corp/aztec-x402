/**
 * Payment references derived, not stored.
 *
 * A reference must be unpredictable (whoever knows it can test on chain
 * whether it was paid) and bound to the terms it was quoted at. Deriving it as
 * an HMAC of the nonce and those terms under a server secret gives both
 * without writing anything when a 402 goes out: every instance that shares the
 * secret recognizes every reference, and an unauthenticated request costs the
 * server no storage. The nonce is a UUIDv7, so the reference's age is read
 * from it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * What a reference is bound to. `route` is the key of the route the quote was
 * issued for (its pattern, e.g. "/api/item/:id"), so a quote for a cheap route
 * cannot pay for an expensive one on the same merchant. `price` is the quoted
 * amount in base units.
 */
export interface QuotedTerms {
  nonce: string;
  route: string;
  network: string;
  asset: string;
  payTo: string;
  price: string;
}

export const MIN_SECRET_BYTES = 32;

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function mac(secret: Uint8Array, t: QuotedTerms): Buffer {
  const message = ["x402-aztec-ref-v2", t.nonce, t.route, t.network, t.asset.toLowerCase(), t.payTo.toLowerCase(), t.price].join("|");
  return createHmac("sha256", secret).update(message).digest();
}

/**
 * The reference for these terms: 31 bytes of HMAC-SHA256, so it is a field
 * element (below the BN254 modulus), written as the SDK writes fields
 * (`0x` and 64 hex digits).
 */
export function derivePaymentRef(secret: Uint8Array, terms: QuotedTerms): string {
  assertSecret(secret);
  return "0x00" + mac(secret, terms).subarray(0, 31).toString("hex");
}

/** Whether `paymentRef` is the one this secret derives for these terms (constant time). */
export function isPaymentRefFor(secret: Uint8Array, terms: QuotedTerms, paymentRef: string): boolean {
  const expected = Buffer.from(derivePaymentRef(secret, terms).slice(2), "hex");
  const hex = paymentRef.startsWith("0x") ? paymentRef.slice(2) : paymentRef;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return false;
  return timingSafeEqual(expected, Buffer.from(hex, "hex"));
}

/** When a UUIDv7 nonce was made (ms since the epoch), or undefined for any other string. */
export function nonceCreatedAt(nonce: string): number | undefined {
  if (!UUID_V7.test(nonce)) return undefined;
  return parseInt(nonce.replace(/-/g, "").slice(0, 12), 16);
}

export function assertSecret(secret: Uint8Array): void {
  if (secret.length < MIN_SECRET_BYTES) {
    throw new Error(`The payment reference secret must be at least ${MIN_SECRET_BYTES} random bytes.`);
  }
}
