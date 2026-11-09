/**
 * Payment modes beyond the commitment flow, for the inference-money USDC.
 *
 * - `commitment`: the merchant opens a request on chain (X-402-PREPARE), the
 *   buyer pays into it, the completion log proves it. The amount is public.
 * - `ref`: the merchant hands out a random payment reference; the buyer pays it
 *   with a private transfer (`pay_private`) and hands the merchant the
 *   transaction's offchain messages (its proof). Nothing on chain shows the
 *   amount or names the merchant, and the merchant sends no transaction.
 * - `split`: the buyer makes one Ethereum deposit of a round amount whose
 *   secret commits to merchant, price and reference; the merchant serves once
 *   the deposit is confirmed on L1 and claims the price on Aztec later.
 *
 * A 402 offers one `accepts` entry per mode, all sharing one nonce (and, for
 * `ref` and `split`, one reference); `extra.mode` tells them apart. A client
 * that does not know `extra.mode` takes the first entry and runs the
 * commitment flow on its nonce, which the server still accepts.
 */
import { z } from "zod";

export const PAYMENT_MODES = ["commitment", "ref", "split"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];
export const PaymentModeSchema = z.enum(PAYMENT_MODES);

/**
 * An offchain message lives at most 26 h past its transaction's anchor
 * (aztec-nr's MAX_TX_LIFETIME + 2 h): the window in which a merchant can still
 * take in a stored proof, and so how long a server keeps an issued reference.
 */
export const OFFCHAIN_MESSAGE_TTL_MS = 26 * 60 * 60 * 1000;

/**
 * The 402 error for a `ref` or `split` payment whose reference was served
 * already. A reference is served once, also to the buyer who paid it: a
 * response lost after serving cannot be delivered again.
 */
export const PAYMENT_ALREADY_USED = "payment already used";

/** Messages a ref proof may carry; the SDK's own bound. One payment carries two (note and event). */
export const MAX_PROOF_MESSAGES = 16;
/** Fields per message ciphertext; a message is 15 today. */
export const MAX_CIPHERTEXT_FIELDS = 64;

const field = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/, "expected a 0x-prefixed field");
const address = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte 0x-prefixed address");
const hash32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte 0x-prefixed hash");
const ethAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte 0x-prefixed address");
const decimal = z.string().regex(/^[0-9]{1,78}$/, "expected a decimal integer");

/** One offchain message of a ref payment: the SDK's `ProofMessage`. */
export const RefProofMessageSchema = z.object({
  recipient: address,
  contractAddress: address,
  ciphertext: z.array(field).min(1).max(MAX_CIPHERTEXT_FIELDS),
  anchorBlockTimestamp: decimal,
});

/** What a buyer hands the merchant after `payPrivate`: the SDK's `PaymentProof`. */
export const RefPaymentProofSchema = z.object({
  txHash: hash32,
  paymentRef: field,
  messages: z.array(RefProofMessageSchema).min(1).max(MAX_PROOF_MESSAGES),
});

/** What a buyer hands the merchant after a split deposit: the SDK's `SplitProof`. */
export const SplitPaymentProofSchema = z.object({
  l1TxHash: hash32,
  price: decimal,
  paymentRef: field,
  changeCommitment: field,
  salt: field,
});

/** `PaymentPayload.payload` of a ref payment. */
export const RefAztecPayloadSchema = RefPaymentProofSchema.extend({ mode: z.literal("ref") });
/** `PaymentPayload.payload` of a split payment. */
export const SplitAztecPayloadSchema = SplitPaymentProofSchema.extend({ mode: z.literal("split") });

export type RefProofMessage = z.infer<typeof RefProofMessageSchema>;
export type RefPaymentProof = z.infer<typeof RefPaymentProofSchema>;
export type SplitPaymentProof = z.infer<typeof SplitPaymentProofSchema>;
export type RefAztecPayload = z.infer<typeof RefAztecPayloadSchema>;
export type SplitAztecPayload = z.infer<typeof SplitAztecPayloadSchema>;

/** What a split offer adds to `extra`: enough for the buyer to build the deposit and check it against its own manifest. */
export const SplitTermsSchema = z.object({
  /** The merchant's Aztec address (the route's `payTo`). */
  merchant: address,
  /** The price in base units; the deposit is a larger round amount. */
  price: decimal,
  /** The deposit amounts the buyer may pick from, in base units. */
  denominations: z.array(decimal).min(1),
  /** L1 chain id of the bridge. */
  chainId: z.number().int().positive(),
  /** The bridge's L1 portal; a buyer refuses a portal its own manifest does not name. */
  portal: ethAddress,
});
export type SplitTerms = z.infer<typeof SplitTermsSchema>;

/** The mode of a payment payload; undefined for the commitment flow, which names none. */
export function payloadMode(payload: Record<string, unknown>): PaymentMode | undefined {
  const parsed = PaymentModeSchema.safeParse(payload.mode);
  return parsed.success ? parsed.data : undefined;
}

/** Result of verifying a `ref` or `split` payment. */
export interface ModeVerification {
  isValid: boolean;
  /** The amount paid, when known. */
  amountFound?: bigint;
  /** The SDK's refusal reason (`not-mined`, `underpaid`, ...). */
  reason?: string;
  error?: string;
  /** The proof may verify later (not mined, not confirmed yet): keep it and let the buyer retry. */
  retryable?: boolean;
  /** Split only: the claim the merchant persists and later claims on Aztec, as JSON. */
  splitClaim?: string;
  /** The transaction that paid: the Aztec tx (ref) or the L1 deposit (split). */
  transaction?: string;
}
