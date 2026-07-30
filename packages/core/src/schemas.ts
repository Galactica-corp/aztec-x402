import { z } from "zod";
import { AZTEC_NETWORKS } from "./types.js";

export const AztecNetworkSchema = z.enum([
  AZTEC_NETWORKS.SANDBOX,
  AZTEC_NETWORKS.TESTNET,
  AZTEC_NETWORKS.DEVNET,
]);

export const AztecPaymentExtraSchema = z
  .object({
    nonce: z.string().optional(),
    commitment: z.string().optional(),
    offchainMessage: z.string().optional(),
    prepareTxHash: z.string().optional(),
  })
  .catchall(z.unknown());

export const AztecPrepareRequestSchema = z.object({
  nonce: z.string().min(1),
  senderAddress: z.string().min(1),
});

export const AztecSdkResultSchema = z
  .object({
    result: z.unknown().optional(),
  })
  .catchall(z.unknown());

export const AztecOffchainMessageSchema = z
  .object({
    payload: z.unknown(),
    recipient: z.unknown().optional(),
    // Aztec v5 hands this over as a bigint. Coerce so the serialized message
    // stays a plain JSON number for the client, which feeds it straight into
    // the token ABI's `anchor_block_timestamp`.
    anchorBlockTimestamp: z.coerce.number().optional(),
  })
  .catchall(z.unknown());

export const AztecOffchainMessagesSchema = z.array(AztecOffchainMessageSchema);

const txEffectDataSchema = z
  .object({
    noteHashes: z.array(z.unknown()).optional(),
    nullifiers: z.array(z.unknown()).optional(),
  })
  .catchall(z.unknown());

export const AztecTxEffectSchema = z
  .object({
    noteHashes: z.array(z.unknown()).optional(),
    nullifiers: z.array(z.unknown()).optional(),
    data: txEffectDataSchema.optional(),
  })
  .catchall(z.unknown());

export type AztecPaymentExtra = z.infer<typeof AztecPaymentExtraSchema>;
export type AztecPrepareRequest = z.infer<typeof AztecPrepareRequestSchema>;
export type AztecOffchainMessage = z.infer<typeof AztecOffchainMessageSchema>;

export function parseAztecPaymentExtra(extra: unknown): AztecPaymentExtra {
  return AztecPaymentExtraSchema.parse(extra ?? {});
}

export function unwrapAztecSdkResult(result: unknown): unknown {
  const parsed = AztecSdkResultSchema.safeParse(result);
  if (parsed.success && "result" in parsed.data) {
    return parsed.data.result;
  }
  return result;
}

export function getAztecTxEffectArray(
  effect: unknown,
  key: "noteHashes" | "nullifiers",
): unknown[] {
  const parsed = AztecTxEffectSchema.safeParse(effect);
  if (!parsed.success) return [];
  return parsed.data.data?.[key] ?? parsed.data[key] ?? [];
}
