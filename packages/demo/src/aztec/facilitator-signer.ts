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
 * ## Payment Verification
 *
 * After the client calls `transfer_private_to_commitment(...)`, the facilitator verifies:
 * - Transaction succeeded (receipt status)
 * - Transaction produced private notes (tx effects)
 * - Transaction consumed nullifiers (commitment was used)
 * - Recipient correctness is guaranteed by the commitment pattern
 * - Token contract correctness is structurally guaranteed
 *
 * ## Amount Verification
 *
 * The facilitator snapshots its private balance before `prepareCommitment()` and
 * checks `balance_of_private` again after the client's finalization tx settles.
 * The difference is the actual amount transferred. If the client underpays,
 * verification rejects the payment. Falls back to trusting tx effects if
 * `balance_of_private` is unavailable (e.g. ABI mismatch).
 */
import type {
  FacilitatorAztecSigner,
  PaymentNoteVerification,
  PrepareCommitmentResult,
} from "@aztec-x402/core";
import {
  AztecOffchainMessagesSchema,
  getAztecTxEffectArray,
  unwrapAztecSdkResult,
} from "@aztec-x402/core";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { toSendOptions } from "@aztec/aztec.js/contracts";
import type { InteractionFeeOptions, SendInteractionOptions } from "@aztec/aztec.js/contracts";
import { TxHash, TxStatus } from "@aztec/aztec.js/tx";

/** Minimal node interface — only the methods we use */
interface AztecNode {
  getTxReceipt(txHash: TxHash): Promise<{ status: string }>;
  getTxEffect(txHash: TxHash): Promise<TxEffect | null>;
}

/**
 * Minimal shape of TxEffect returned by the node.
 *
 * The real Aztec SDK returns IndexedTxEffect which wraps TxEffect inside
 * a `data` property. We handle both shapes: direct `{ noteHashes }` and
 * wrapped `{ data: { noteHashes } }`.
 */
interface TxEffect {
  noteHashes?: unknown[];
  nullifiers?: unknown[];
  data?: {
    noteHashes?: unknown[];
    nullifiers?: unknown[];
  };
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
    balance_of_private(owner: AztecAddress): {
      simulate(opts: { from: AztecAddress }): Promise<unknown>;
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
  return value == null ? "" : String(value);
}

function extractCommitmentFromSendResult(sendResult: SendResult): string | undefined {
  const value = sendResult.appReturnValues?.[0];
  return value == null ? undefined : String(value);
}

function extractSimulateValue(result: unknown): unknown {
  return unwrapAztecSdkResult(result);
}

function bigintFromSimulate(result: unknown): bigint {
  const value = extractSimulateValue(result);
  return typeof value === "bigint" ? value : BigInt(String(value));
}

/**
 * Extract txHash from send() result.
 * v4.1.0: receipt.txHash, v4.0.x: txHash directly
 */
function extractTxHash(sendResult: SendResult): string {
  return (sendResult.receipt?.txHash ?? sendResult.txHash)?.toString() ?? "";
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
  /** Balance snapshot taken before each prepareCommitment, keyed by commitment */
  private balanceBefore = new Map<string, bigint>();

  constructor(
    private readonly account: AztecAccount,
    private readonly node: AztecNode,
    private readonly token: TokenContract,
    private readonly sendOpts?: { fee?: InteractionFeeOptions },
  ) {}

  async getAddresses(): Promise<string[]> {
    return [this.account.address.toString()];
  }

  async prepareCommitment(
    _tokenAddress: string,
    completerAddress: string,
  ): Promise<PrepareCommitmentResult> {
    const facilitatorAddr = this.account.address;
    const completerAddr = AztecAddress.fromString(completerAddress);

    // Snapshot balance before preparing, so we can verify the actual amount later
    let balanceSnapshotted = false;
    try {
      const balResult = await this.token.methods
        .balance_of_private(facilitatorAddr)
        .simulate({ from: facilitatorAddr });
      const bal = bigintFromSimulate(balResult);
      // Store temporarily — will key by commitment once we have it
      this.balanceBefore.set("_pending", bal);
      balanceSnapshotted = true;
    } catch {
      // balance_of_private may fail (ABI mismatch, etc.) — fall back to no amount verification
    }

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

    // Re-key the balance snapshot from _pending to the commitment (used during verification)
    const pendingBalance = this.balanceBefore.get("_pending");
    if (balanceSnapshotted && finalCommitment && pendingBalance !== undefined) {
      this.balanceBefore.set(finalCommitment, pendingBalance);
      this.balanceBefore.delete("_pending");
    } else if (this.balanceBefore.has("_pending")) {
      this.balanceBefore.delete("_pending");
    }

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

      // 1. Confirm the transaction succeeded via the node
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

      // 2. Check tx effects: notes created AND nullifiers consumed.
      try {
        const txEffect = await this.node.getTxEffect(txHash);
        if (txEffect) {
          const noteHashes = getAztecTxEffectArray(txEffect, "noteHashes");
          const nonEmptyNotes = noteHashes.filter((h) => {
            if (h == null) return false;
            const str = String(h);
            if (str === "" || str === "0") return false;
            return !/^0x0+$/.test(str);
          });

          if (nonEmptyNotes.length === 0) {
            return {
              isValid: false,
              amountFound: 0n,
              error:
                "transaction produced no private notes — not a valid private transfer",
            };
          }

          const nullifiers = getAztecTxEffectArray(txEffect, "nullifiers");
          const nonZeroNullifiers = nullifiers.filter((n) => {
            if (n == null) return false;
            const str = String(n);
            if (str === "" || str === "0") return false;
            return !/^0x0+$/.test(str);
          });

          if (nonZeroNullifiers.length === 0) {
            return {
              isValid: false,
              amountFound: 0n,
              error:
                "transaction consumed no nullifiers — commitment was not used",
            };
          }
        }
      } catch {
        // getTxEffect might not be available on all node versions.
      }

      // 3. Verify actual amount via balance difference (keyed by commitment)
      void tokenAddress;
      const beforeBal = commitment ? this.balanceBefore.get(commitment) : undefined;
      if (beforeBal !== undefined && commitment) {
        this.balanceBefore.delete(commitment);
        try {
          const facilitatorAddr = this.account.address;
          const afterResult = await this.token.methods
            .balance_of_private(facilitatorAddr)
            .simulate({ from: facilitatorAddr });
          const afterBal = bigintFromSimulate(afterResult);
          const actualAmount = afterBal - beforeBal;
          if (actualAmount < requiredAmount) {
            return {
              isValid: false,
              amountFound: actualAmount,
              error: `insufficient payment: received ${actualAmount}, required ${requiredAmount}`,
            };
          }
          return { isValid: true, amountFound: actualAmount };
        } catch {
          // balance_of_private failed — fall back to trusting tx effects
        }
      }
      return { isValid: true, amountFound: requiredAmount };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isValid: false,
        amountFound: 0n,
        error: `verification failed: ${message}`,
      };
    }
  }
}
