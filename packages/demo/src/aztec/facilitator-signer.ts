/**
 * Real FacilitatorAztecSigner — wraps an Aztec AccountManager, AztecNode,
 * and token contract to handle commitment creation and payment verification.
 *
 * ## v4.1.0 API Changes
 *
 * On v4.1.0+:
 * - `send()` returns `{ receipt, offchainEffects, offchainMessages }`
 * - `simulate()` returns `{ result: { commitment }, offchainEffects, offchainMessages }`
 * - The commitment field is now inside `result.commitment` (not top-level)
 * - `offchainMessages` may contain encrypted note-delivery payloads
 *
 * The commitment is extracted from `simulate().result` on v4.1.0+ (returns Field directly).
 * Offchain messages are forwarded separately to the client for PXE note processing.
 *
 * ## Payment Verification — Commitment-Tagged Completion Log
 *
 * Every successful `transfer_*_to_commitment` call completes the partial note via
 * `PartialUintNote::complete{_from_private}`, which emits a completion log keyed
 * by a tag derived from the commitment:
 *
 *   log_tag    = poseidon2(commitment ; DOM_SEP__NOTE_COMPLETION_LOG_TAG)
 *   siloedTag  = poseidon2(tokenAddr, log_tag ; PRIVATE_LOG_FIRST_FIELD)
 *   logData    = [siloedTag, storage_slot, value, 0, 0, ...]
 *
 * The facilitator recovers `(storage_slot, value)` by querying the node for the
 * log with this tag — `complete_from_private` emits it via the private channel,
 * `complete` via the public channel, so we try both. Because `commitment` is
 * unique per partial note, the lookup is O(1) and immune to concurrent payments
 * (no shared mutable state, no balance snapshots).
 *
 * Verification checks:
 * - Tx receipt status is one of the accepted statuses.
 * - Token address matches.
 * - A completion log with the derived tag exists.
 * - `log.txHash` matches the txHash supplied by the client (binds the proof).
 * - Recovered `value >= requiredAmount`.
 */
import type {
  FacilitatorAztecSigner,
  PaymentNoteVerification,
  PrepareCommitmentResult,
} from "@aztec-x402/core";
import {
  AztecOffchainMessagesSchema,
  unwrapAztecSdkResult,
} from "@aztec-x402/core";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { toSendOptions } from "@aztec/aztec.js/contracts";
import type { InteractionFeeOptions, SendInteractionOptions } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import { TxHash, TxStatus } from "@aztec/aztec.js/tx";
import { DomainSeparator } from "@aztec/constants";
import { computeLogTag, computeSiloedPrivateLogFirstField } from "@aztec/stdlib/hash";
import { SiloedTag, Tag, type TxScopedL2Log } from "@aztec/stdlib/logs";

/**
 * Subset of `@aztec/stdlib/interfaces/client`'s `AztecNode` that the facilitator
 * uses. The real `AztecNode` client returned by `createAztecNodeClient(...)`
 * satisfies this shape — we keep a narrowed local interface so this module
 * stays decoupled from the rest of the SDK surface.
 */
interface AztecNode {
  getTxReceipt(txHash: TxHash): Promise<{ status: string }>;
  getPrivateLogsByTags(tags: SiloedTag[]): Promise<TxScopedL2Log[][]>;
  getPublicLogsByTagsFromContract(
    contractAddress: AztecAddress,
    tags: Tag[],
  ): Promise<TxScopedL2Log[][]>;
}

interface AztecAccount {
  address: AztecAddress;
}

interface OffchainMessage {
  payload: unknown;
  recipient?: unknown;
  anchorBlockTimestamp?: number;
}

/**
 * v4.1.0 send() result shape.
 *
 * Confirmed on sandbox 4.1.0-nightly.20260314:
 * - Keys: `receipt, offchainEffects, offchainMessages`
 * - `txHash` is on `receipt`, not top-level
 * - For deploy methods: `contract, receipt, offchainEffects, offchainMessages`
 */
interface SendResult {
  receipt?: { txHash?: { toString(): string }; status?: string };
  offchainEffects?: unknown[];
  offchainMessages?: OffchainMessage[];
  appReturnValues?: unknown[];
  // v4.0.x compat
  txHash?: { toString(): string };
}

/**
 * v4.1.0 simulate() result shape for initialize_transfer_commitment.
 *
 * AIP-20 returns Field directly: `{ result: Field, offchainEffects: [], offchainMessages: [] }`
 */
interface SimulateResult {
  result?: unknown;
  offchainEffects?: unknown[];
  offchainMessages?: OffchainMessage[];
}

interface TokenContract {
  address?: { toString(): string };
  methods: {
    initialize_transfer_commitment(
      to: AztecAddress,
      completer: AztecAddress,
    ): {
      simulate(opts: { from: AztecAddress }): Promise<SimulateResult | unknown>;
      request?(opts: Record<string, unknown>): Promise<unknown>;
      send(opts: Record<string, unknown>): Promise<SendResult>;
      wallet?: {
        sendTxWithAppReturnValues?(
          executionPayload: unknown,
          opts: unknown,
        ): Promise<SendResult>;
      };
    };
  };
}

/**
 * Extract commitment from offchainMessages (future v4.1.x+ when offchain delivery is populated).
 */
/**
 * Extract commitment from simulate() result.
 *
 * AIP-20's initialize_transfer_commitment returns Field directly.
 * v4.1.0 wraps it: `{ result: Field, offchainEffects, offchainMessages }`.
 */
function extractCommitmentFromSimulate(result: unknown): string {
  const value = unwrapAztecSdkResult(result);
  return normalizeCommitment(value);
}

function extractCommitmentFromSendResult(sendResult: SendResult): string | undefined {
  const value = sendResult.appReturnValues?.[0];
  if (value == null) return undefined;
  return normalizeCommitment(value);
}

/**
 * Extract txHash from send() result.
 * v4.1.0: receipt.txHash, v4.0.x: txHash directly
 */
function extractTxHash(sendResult: SendResult): string {
  const txHash = (sendResult.receipt?.txHash ?? sendResult.txHash)?.toString();
  if (!txHash) {
    throw new Error("send() result did not include a transaction hash");
  }
  return txHash;
}

function isNonZeroFieldString(value: string): boolean {
  const trimmed = value.trim();
  if (/^0x[0-9a-fA-F]{1,64}$/.test(trimmed)) {
    return !/^0x0*$/i.test(trimmed);
  }
  if (/^[0-9]+$/.test(trimmed)) {
    return BigInt(trimmed) > 0n;
  }
  return false;
}

function normalizeCommitment(value: unknown): string {
  const commitment = value == null ? "" : String(value);
  if (!isNonZeroFieldString(commitment)) {
    throw new Error("invalid commitment returned by token contract");
  }
  return commitment;
}

function addressesEqual(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Serialize offchain messages for transport to the client.
 */
function serializeOffchainMessage(messages: OffchainMessage[]): string | undefined {
  if (!messages || messages.length === 0) return undefined;
  const parsedMessages = AztecOffchainMessagesSchema.parse(messages);
  return JSON.stringify(parsedMessages, (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const ctor = value.constructor?.name;
      if (ctor && ctor !== "Object") return String(value);
    }
    return value;
  });
}

export class RealFacilitatorAztecSigner implements FacilitatorAztecSigner {
  constructor(
    private readonly account: AztecAccount,
    private readonly node: AztecNode,
    private readonly token: TokenContract,
    private readonly sendOpts?: { fee?: InteractionFeeOptions },
  ) { }

  async getAddresses(): Promise<string[]> {
    return [this.account.address.toString()];
  }

  async prepareCommitment(
    _tokenAddress: string,
    completerAddress: string,
  ): Promise<PrepareCommitmentResult> {
    const facilitatorAddr = this.account.address;
    const completerAddr = AztecAddress.fromString(completerAddress);

    // Create partial note: to=facilitator (recipient), completer=client (who will finalize)
    const interaction =
      this.token.methods.initialize_transfer_commitment(facilitatorAddr, completerAddr);

    const opts: SendInteractionOptions = {
      from: facilitatorAddr,
      wait: { timeout: 240, waitForStatus: TxStatus.CHECKPOINTED },
    };
    if (this.sendOpts?.fee) {
      opts.fee = this.sendOpts.fee;
    }
    let simulateResult: unknown;
    let sendResult: SendResult;
    const walletSend = interaction.wallet?.sendTxWithAppReturnValues;
    if (interaction.request && walletSend) {
      const executionPayload = await interaction.request(opts);
      sendResult = await walletSend.call(
        interaction.wallet,
        executionPayload,
        toSendOptions(opts),
      );
    } else {
      // Fallback for older wallet implementations.
      simulateResult = await interaction.simulate({ from: facilitatorAddr });
      sendResult = await interaction.send(opts);
    }
    const txHash = extractTxHash(sendResult);

    const finalCommitment =
      extractCommitmentFromSendResult(sendResult) ??
      extractCommitmentFromSimulate(simulateResult);

    const result: PrepareCommitmentResult = {
      commitment: finalCommitment,
      prepareTxHash: txHash,
    };
    if (sendResult.offchainMessages && sendResult.offchainMessages.length > 0) {
      result.offchainMessage = serializeOffchainMessage(sendResult.offchainMessages);
    }
    return result;
  }

  async verifyPayment(
    txHashStr: string,
    tokenAddress: string,
    requiredAmount: bigint,
    commitment?: string,
  ): Promise<PaymentNoteVerification> {
    try {
      const txHash = TxHash.fromString(txHashStr);

      const actualTokenAddress = this.token.address?.toString();
      if (actualTokenAddress && !addressesEqual(actualTokenAddress, tokenAddress)) {
        return {
          isValid: false,
          amountFound: 0n,
          error: `wrong token: expected ${actualTokenAddress}, got ${tokenAddress}`,
        };
      }

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

      const receipt = await this.node.getTxReceipt(txHash);
      const validStatuses = [
        "success",
        "proposed",
        "checkpointed",
        "proven",
        "finalized",
      ];
      if (!validStatuses.includes(receipt.status)) {
        return {
          isValid: false,
          amountFound: 0n,
          error: `transaction status is '${receipt.status}'`,
        };
      }

      // Look up the completion log emitted by the token contract when the
      // buyer finalized the partial note. The log is keyed by a tag derived
      // from `commitment` so this lookup is O(1) and immune to concurrent
      // payments.
      const tokenAddr = AztecAddress.fromString(tokenAddress);
      let completion: CompletionLog | null;
      try {
        completion = await this.findCompletionLog(tokenAddr, commitmentFr);
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
  private async findCompletionLog(
    tokenAddr: AztecAddress,
    commitmentFr: Fr,
  ): Promise<CompletionLog | null> {
    const logTag = await computeLogTag(
      commitmentFr,
      DomainSeparator.NOTE_COMPLETION_LOG_TAG,
    );
    const siloedTag = await computeSiloedPrivateLogFirstField(tokenAddr, logTag);

    const privateBuckets = await this.node.getPrivateLogsByTags([
      new SiloedTag(siloedTag),
    ]);
    const candidates: TxScopedL2Log[] =
      privateBuckets[0] && privateBuckets[0].length > 0
        ? privateBuckets[0]
        : (await this.node.getPublicLogsByTagsFromContract(tokenAddr, [
            new Tag(logTag),
          ]))[0] ?? [];

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
}

interface CompletionLog {
  txHash: TxHash;
  storageSlot: Fr;
  value: bigint;
}
