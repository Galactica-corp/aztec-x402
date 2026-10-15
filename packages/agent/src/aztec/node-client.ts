import { createAztecNodeClient, type AztecNode } from "@aztec-labs/aztec.js/node";

/** The public dRPC plan rejects JSON-RPC batches larger than 3. Paid keys are not capped. */
const DRPC_MAX_BATCH_SIZE = 3;

/**
 * Batch cap for a public `*.drpc.org` URL. A key in the path, or a `dkey` query
 * parameter, is a paid endpoint and keeps the SDK's default batch size.
 */
export function publicDrpcMaxBatchSize(url: string): number | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname;
  if (host !== "drpc.org" && !host.endsWith(".drpc.org")) return undefined;
  if (parsed.pathname.replace(/\/+$/, "") !== "") return undefined;
  if (parsed.searchParams.has("dkey")) return undefined;
  return DRPC_MAX_BATCH_SIZE;
}

export function createNodeClient(url: string): AztecNode {
  const maxBatchSize = publicDrpcMaxBatchSize(url);
  if (maxBatchSize !== undefined) return createAztecNodeClient(url, { maxBatchSize });
  return createAztecNodeClient(url);
}
