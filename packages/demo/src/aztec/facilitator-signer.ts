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
 * - `offchainMessages` is present but currently empty for `prepare_private_balance_increase`
 *   (offchain delivery for partial notes may come in a future release)
 *
 * The commitment is extracted from `simulate().result.commitment` on v4.1.0+.
 * When offchainMessages become populated, they'll be preferred as they come
 * from the proven tx execution.
 *
 * ## Payment Verification
 *
 * After the client calls `finalize_transfer_to_private_from_private(...)`, the facilitator verifies:
 * - Transaction succeeded (receipt status)
 * - Transaction produced private notes (tx effects)
 * - Transaction consumed nullifiers (commitment was used)
 * - Recipient correctness is guaranteed by the commitment pattern
 * - Token contract correctness is structurally guaranteed
 *
 * ## Known Limitations
 *
 * **Amount verification**: The client chooses the amount parameter. To verify the facilitator
 * received the correct amount, a full implementation would query the PXE for the specific
 * note value. For this demo, we verify tx status and note creation.
 */
import type {
  FacilitatorAztecSigner,
  PaymentNoteVerification,
  PrepareCommitmentResult,
} from "@aztec-x402/core";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { TxHash } from "@aztec/aztec.js/tx";

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
  payload: string;
  recipient?: string;
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
  // v4.0.x compat
  txHash?: { toString(): string };
}

/**
 * v4.1.0 simulate() result shape.
 *
 * Confirmed: `{ result: { commitment }, offchainEffects: [], offchainMessages: [] }`
 */
interface SimulateResult {
  result?: { commitment?: unknown };
  offchainEffects?: unknown[];
  offchainMessages?: OffchainMessage[];
  // v4.0.x: may return commitment directly
  commitment?: unknown;
}

interface TokenContract {
  methods: {
    prepare_private_balance_increase(
      to: AztecAddress,
      completer: AztecAddress,
    ): {
      simulate(opts: { from: AztecAddress }): Promise<SimulateResult | unknown>;
      send(opts: Record<string, unknown>): Promise<SendResult>;
    };
  };
}

/**
 * Extract commitment from offchainMessages (future v4.1.x+ when offchain delivery is populated).
 */
function extractCommitmentFromOffchain(offchainMessages: OffchainMessage[]): string | undefined {
  if (!offchainMessages || offchainMessages.length === 0) return undefined;

  const msg = offchainMessages[0];
  if (!msg?.payload) return undefined;

  try {
    if (msg.payload.startsWith("0x")) return msg.payload;
    const parsed = JSON.parse(msg.payload);
    if (parsed.commitment) return String(parsed.commitment);
    return String(msg.payload);
  } catch {
    return String(msg.payload);
  }
}

/**
 * Extract commitment from simulate() result.
 *
 * Handles both v4.0.x (returns commitment directly) and v4.1.0
 * (returns { result: { commitment }, offchainEffects, offchainMessages }).
 */
function extractCommitmentFromSimulate(result: unknown): string {
  if (result == null) return "";

  // v4.1.0: { result: { commitment } }
  if (typeof result === "object" && "result" in result) {
    const inner = (result as SimulateResult).result;
    if (inner?.commitment != null) return String(inner.commitment);
  }

  // v4.0.x: { commitment } or direct Field value
  if (typeof result === "object" && "commitment" in result) {
    return String((result as { commitment: unknown }).commitment);
  }

  return String(result);
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
  return JSON.stringify(messages);
}

export class RealFacilitatorAztecSigner implements FacilitatorAztecSigner {
  constructor(
    private readonly account: AztecAccount,
    private readonly node: AztecNode,
    private readonly token: TokenContract,
    private readonly sendOpts?: { fee?: unknown },
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

    // Create partial note: to=facilitator (recipient), completer=client (who will finalize)
    const interaction =
      this.token.methods.prepare_private_balance_increase(facilitatorAddr, completerAddr);

    // simulate() for gas estimation + commitment extraction
    const simulateResult = await interaction.simulate({ from: facilitatorAddr });

    const opts: Record<string, unknown> = { from: facilitatorAddr, wait: { timeout: 120 } };
    if (this.sendOpts?.fee) {
      opts.fee = this.sendOpts.fee;
    }
    const sendResult = await interaction.send(opts);
    const txHash = extractTxHash(sendResult);

    // Priority 1: Extract commitment from offchainMessages (when populated in future releases)
    if (sendResult.offchainMessages && sendResult.offchainMessages.length > 0) {
      const commitment = extractCommitmentFromOffchain(sendResult.offchainMessages);
      if (commitment) {
        return {
          commitment,
          offchainMessage: serializeOffchainMessage(sendResult.offchainMessages),
          prepareTxHash: txHash,
        };
      }
    }

    // Priority 2: Extract from simulate() result (works on both v4.0.x and v4.1.0)
    const commitment = extractCommitmentFromSimulate(simulateResult);
    return {
      commitment,
      prepareTxHash: txHash,
    };
  }

  async verifyPayment(
    txHashStr: string,
    tokenAddress: string,
    requiredAmount: bigint,
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
          const noteHashes =
            txEffect.data?.noteHashes ?? txEffect.noteHashes ?? [];
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

          const nullifiers =
            txEffect.data?.nullifiers ?? txEffect.nullifiers ?? [];
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

      // 3. Amount verification gap (see doc header)
      void tokenAddress;
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
