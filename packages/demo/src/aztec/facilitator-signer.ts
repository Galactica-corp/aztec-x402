/**
 * Real FacilitatorAztecSigner — wraps an Aztec AccountManager and AztecNode
 * to verify direct private token transfers.
 *
 * ## Direct Transfer Payment Flow
 *
 * 1. The client calls `transfer_private_to_private(from, payTo, amount, nonce)`
 *    to send tokens directly to the facilitator's address.
 *
 * 2. `verifyPayment()` checks:
 *    - Transaction succeeded (receipt status)
 *    - Transaction produced private notes (tx effects)
 *
 * ## Amount Verification
 *
 * The ZK proof guarantees the transfer logic is valid. To verify the
 * facilitator received the correct amount, a full implementation would
 * query the PXE for the specific note. For this demo, we verify tx status
 * and note creation; amount verification via PXE is a future improvement.
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

export class RealFacilitatorAztecSigner implements FacilitatorAztecSigner {
  constructor(
    private readonly account: AztecAccount,
    private readonly node: AztecNode,
    private readonly sendOpts?: { fee?: unknown },
  ) {}

  async getAddresses(): Promise<string[]> {
    return [this.account.address.toString()];
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
      //    transfer_private_to_private. A full implementation would query
      //    the PXE for the specific note value. For now, we trust tx success.
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
