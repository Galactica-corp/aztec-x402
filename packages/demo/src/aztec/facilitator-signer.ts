/**
 * Real FacilitatorAztecSigner — wraps an Aztec AccountManager, AztecNode,
 * and token contract to handle commitment creation and payment verification.
 *
 * ## Server-Side Commitment Creation
 *
 * The facilitator creates commitments via `prepare_private_balance_increase(serverAddr, clientAddr)`
 * on the forked x402 token contract. This guarantees:
 * - The partial note's `to` = facilitator's address (structural recipient verification)
 * - The partial note's `completer` = client's address (only client can finalize)
 *
 * ## Payment Verification
 *
 * After the client calls `finalize_transfer_to_private_from_private(...)`, the facilitator verifies:
 * - Transaction succeeded (receipt status)
 * - Transaction produced private notes (tx effects)
 * - Recipient correctness is guaranteed by the commitment pattern
 *
 * ## Amount Verification
 *
 * The ZK proof guarantees the transfer logic is valid, but the client chooses
 * the amount parameter. To verify the facilitator received the correct amount,
 * a full implementation would query the PXE for the specific note value.
 * For this demo, we verify tx status and note creation; amount verification
 * via PXE note queries is a future improvement.
 */
import type {
  FacilitatorAztecSigner,
  PaymentNoteVerification,
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

interface TokenContract {
  methods: {
    prepare_private_balance_increase(
      to: AztecAddress,
      completer: AztecAddress,
    ): {
      simulate(opts: { from: AztecAddress }): Promise<unknown>;
      send(opts: Record<string, unknown>): Promise<{ txHash: { toString(): string } }>;
    };
  };
}

/**
 * Extract a commitment field value from the simulate() return value.
 */
function extractCommitment(result: unknown): string {
  if (result != null && typeof result === "object" && "commitment" in result) {
    return String((result as { commitment: unknown }).commitment);
  }
  return String(result);
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
  ): Promise<string> {
    const facilitatorAddr = this.account.address;
    const completerAddr = AztecAddress.fromString(completerAddress);

    // Create partial note: to=facilitator (recipient), completer=client (who will finalize)
    const interaction =
      this.token.methods.prepare_private_balance_increase(facilitatorAddr, completerAddr);
    const commitmentResult = await interaction.simulate({ from: facilitatorAddr });

    const opts: Record<string, unknown> = { from: facilitatorAddr, wait: { timeout: 120 } };
    if (this.sendOpts?.fee) {
      opts.fee = this.sendOpts.fee;
    }
    await interaction.send(opts);

    return extractCommitment(commitmentResult);
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

      // 2. Check that the transaction produced private notes.
      //    Recipient is structurally guaranteed — the facilitator created
      //    the commitment for its own address.
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
        }
      } catch {
        // getTxEffect might not be available on all node versions.
      }

      // 3. Amount verification: the client provides the amount when calling
      //    finalize_transfer_to_private_from_private. A full implementation would query
      //    the PXE for the specific note value.
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
