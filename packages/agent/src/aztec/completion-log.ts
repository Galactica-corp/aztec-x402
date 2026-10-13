/**
 * Payment verification, shared by every token kind built on aztec-nr partial notes.
 *
 * Every successful `transfer_*_to_commitment` call completes the partial note via
 * `PartialUintNote::complete{_from_private}`, which emits a completion log keyed
 * by a tag derived from the commitment:
 *
 *   log_tag    = poseidon2(commitment ; DOM_SEP__NOTE_COMPLETION_LOG_TAG)
 *   siloedTag  = poseidon2(tokenAddr, log_tag ; PRIVATE_LOG_FIRST_FIELD)
 *   logData    = [siloedTag, storage_slot, value, 0, 0, ...]
 *
 * The merchant recovers `(storage_slot, value)` by querying the node for the
 * log with this tag — `complete_from_private` emits it via the private channel,
 * `complete` via the public channel, so we try both. Because `commitment` is
 * unique per partial note, the lookup is O(1) and immune to concurrent payments
 * (no shared mutable state, no balance snapshots).
 *
 * Verification checks:
 * - Tx receipt status is one of the accepted statuses.
 * - A completion log with the derived tag exists.
 * - `log.txHash` matches the txHash supplied by the client (binds the proof).
 * - Recovered `value >= requiredAmount`.
 */
import type { PaymentNoteVerification } from "@galactica-net/x402-core";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { TxHash } from "@aztec-labs/aztec.js/tx";
import { computeLogTag, computeSiloedPrivateLogFirstField } from "@aztec-labs/stdlib/hash";
import { SiloedTag, Tag, type LogResult } from "@aztec-labs/stdlib/logs";

/**
 * `aztec::note::partial_note::DOM_SEP__NOTE_COMPLETION_LOG_TAG` from aztec-nr
 * v6.0.0-rc.1. The TypeScript `DomainSeparator` enum no longer includes it, so
 * it is typed as a plain number, which `computeLogTag` still accepts.
 */
const NOTE_COMPLETION_LOG_TAG: number = 3372669888;

/**
 * Subset of `@aztec-labs/stdlib/interfaces/client`'s `AztecNode` that verification
 * uses. The real `AztecNode` client returned by `createAztecNodeClient(...)`
 * satisfies this shape.
 *
 * Receipts split block lifecycle (`status`) from execution outcome
 * (`executionResult`), and the tag-based log lookups take a query object and
 * return `LogResult[][]` — one bucket per requested tag.
 */
export interface CompletionLogNode {
  getTxReceipt(txHash: TxHash): Promise<{ status: string; executionResult?: string }>;
  getPrivateLogsByTags(query: { tags: SiloedTag[] }): Promise<LogResult[][]>;
  getPublicLogsByTags(query: {
    contractAddress: AztecAddress;
    tags: Tag[];
  }): Promise<LogResult[][]>;
}

/** `TxStatus` values that mean the tx made it into a block. */
const MINED_STATUSES = ["proposed", "checkpointed", "proven", "finalized"];

interface CompletionLog {
  txHash: TxHash;
  storageSlot: Fr;
  value: bigint;
}

export function isNonZeroFieldString(value: string): boolean {
  const trimmed = value.trim();
  if (/^0x[0-9a-fA-F]{1,64}$/.test(trimmed)) {
    return !/^0x0*$/i.test(trimmed);
  }
  if (/^[0-9]+$/.test(trimmed)) {
    return BigInt(trimmed) > 0n;
  }
  return false;
}

/**
 * Verify that `txHashStr` paid at least `requiredAmount` of `tokenAddress` into `commitment`.
 * Never throws: every failure is reported in the result.
 */
export async function verifyCompletion(
  node: CompletionLogNode,
  txHashStr: string,
  tokenAddress: string,
  requiredAmount: bigint,
  commitment?: string,
): Promise<PaymentNoteVerification> {
  try {
    const txHash = TxHash.fromString(txHashStr);

    if (!commitment || !isNonZeroFieldString(commitment)) {
      return {
        isValid: false,
        amountFound: 0n,
        error: "missing or invalid commitment",
      };
    }

    let commitmentFr: Fr;
    try {
      commitmentFr = Fr.fromString(commitment);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isValid: false,
        amountFound: 0n,
        error: `invalid commitment: ${message}`,
      };
    }

    const receipt = await node.getTxReceipt(txHash);
    if (!MINED_STATUSES.includes(receipt.status)) {
      return {
        isValid: false,
        amountFound: 0n,
        error: `transaction status is '${receipt.status}'`,
      };
    }
    if (receipt.executionResult && receipt.executionResult !== "success") {
      return {
        isValid: false,
        amountFound: 0n,
        error: `transaction execution ${receipt.executionResult}`,
      };
    }

    // Look up the completion log emitted by the token contract when the
    // buyer finalized the partial note. The log is keyed by a tag derived
    // from `commitment` so this lookup is O(1) and immune to concurrent
    // payments.
    const tokenAddr = AztecAddress.fromStringUnsafe(tokenAddress);
    let completion: CompletionLog | null;
    try {
      completion = await findCompletionLog(node, tokenAddr, commitmentFr);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isValid: false,
        amountFound: 0n,
        error: `completion log lookup failed: ${message}`,
      };
    }

    if (!completion) {
      return {
        isValid: false,
        amountFound: 0n,
        error: "no completion log found for commitment",
      };
    }

    if (!completion.txHash.equals(txHash)) {
      return {
        isValid: false,
        amountFound: 0n,
        error: `completion log belongs to tx ${completion.txHash.toString()}, not ${txHashStr}`,
      };
    }

    if (completion.value < requiredAmount) {
      return {
        isValid: false,
        amountFound: completion.value,
        error: `insufficient payment: received ${completion.value}, required ${requiredAmount}`,
      };
    }

    return { isValid: true, amountFound: completion.value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isValid: false,
      amountFound: 0n,
      error: `verification failed: ${message}`,
    };
  }
}

/**
 * Look up the partial-note completion log keyed by `commitment` for `tokenAddr`.
 *
 * Wonderland's `transfer_private_to_commitment` goes through
 * `PartialUintNote::complete_from_private`, which emits a private log:
 *
 *   log_tag    = compute_log_tag(commitment, DOM_SEP__NOTE_COMPLETION_LOG_TAG)
 *   on-chain   = compute_siloed_private_log_first_field(tokenAddr, log_tag)
 *   logData    = [siloedTag, storage_slot, value, 0, ...]
 *
 * Public completion paths (`transfer_public_to_commitment`, `mint_to_commitment`)
 * use `PartialUintNote::complete`, which emits the same payload on the public
 * log channel (no siloing, raw `log_tag` is the on-chain key). We try the
 * private channel first and fall back to the public one.
 *
 * Returns `null` if no log is found or if more than one matches (a
 * well-formed contract emits exactly one completion log per commitment).
 */
async function findCompletionLog(
  node: CompletionLogNode,
  tokenAddr: AztecAddress,
  commitmentFr: Fr,
): Promise<CompletionLog | null> {
  const logTag = await computeLogTag(
    commitmentFr,
    NOTE_COMPLETION_LOG_TAG,
  );
  const siloedTag = await computeSiloedPrivateLogFirstField(tokenAddr, logTag);

  const privateBuckets = await node.getPrivateLogsByTags({
    tags: [new SiloedTag(siloedTag)],
  });
  const candidates: LogResult[] =
    privateBuckets[0] && privateBuckets[0].length > 0
      ? privateBuckets[0]
      : (
          await node.getPublicLogsByTags({
            contractAddress: tokenAddr,
            tags: [new Tag(logTag)],
          })
        )[0] ?? [];

  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    // Defensive: a well-formed contract emits exactly one completion log
    // per commitment. Multiple matches indicate either a hash collision
    // or contract misbehaviour — reject rather than guess.
    return null;
  }

  const log = candidates[0];
  // logData layout: [tag, storage_slot, value, ...trailing zero padding]
  return {
    txHash: log.txHash,
    storageSlot: log.logData[1],
    value: log.logData[2].toBigInt(),
  };
}
