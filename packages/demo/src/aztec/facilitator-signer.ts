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
 * verification rejects the payment. If amount verification cannot be completed,
 * verification fails closed.
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
  return normalizeCommitment(value);
}

function extractCommitmentFromSendResult(sendResult: SendResult): string | undefined {
  const value = sendResult.appReturnValues?.[0];
  if (value == null) return undefined;
  return normalizeCommitment(value);
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
    let balanceBefore: bigint | undefined;
    try {
      const balResult = await this.token.methods
        .balance_of_private(facilitatorAddr)
        .simulate({ from: facilitatorAddr });
      balanceBefore = bigintFromSimulate(balResult);
    } catch {
      // verifyPayment fails closed if this snapshot is unavailable.
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

    if (balanceBefore !== undefined) {
      this.balanceBefore.set(finalCommitment, balanceBefore);
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
      let txEffect: TxEffect | null;
      try {
        txEffect = await this.node.getTxEffect(txHash);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isValid: false,
          amountFound: 0n,
          error: `transaction effects unavailable: ${message}`,
        };
      }
      if (!txEffect) {
        return {
          isValid: false,
          amountFound: 0n,
          error: "transaction effects unavailable",
        };
      }

      const noteHashes = getAztecTxEffectArray(txEffect, "noteHashes");
      const nonEmptyNotes = noteHashes.filter((h) => {
        if (h == null) return false;
        const str = String(h);
        if (str === "" || str === "0") return false;
        return !/^0x0+$/i.test(str);
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
        return !/^0x0+$/i.test(str);
      });

      if (nonZeroNullifiers.length === 0) {
        return {
          isValid: false,
          amountFound: 0n,
          error:
            "transaction consumed no nullifiers — commitment was not used",
        };
      }

      // 3. Verify actual amount via balance difference (keyed by commitment)
      const beforeBal = this.balanceBefore.get(commitment);
      if (beforeBal === undefined) {
        return {
          isValid: false,
          amountFound: 0n,
          error: "amount snapshot unavailable for commitment",
        };
      }
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isValid: false,
          amountFound: 0n,
          error: `amount verification failed: ${message}`,
        };
      }
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
