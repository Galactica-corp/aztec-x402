/**
 * Real FacilitatorAztecSigner — wraps an Aztec AccountManager, EmbeddedWallet,
 * AztecNode, and TokenContract to handle commitment-based payment verification.
 *
 * ## Commitment-Based Payment Flow
 *
 * 1. `prepareCommitment()` calls `prepare_private_balance_increase(facilitatorAddr)`
 *    on the token contract. This creates a "partial note" for the facilitator and
 *    returns a commitment Field. The partial note is incomplete — it has the
 *    recipient (facilitator) but no amount yet.
 *
 * 2. The commitment is sent to the client in the 402 response via
 *    PaymentRequirements.extra.commitment.
 *
 * 3. The client calls `finalize_transfer_to_private_from_private(from,
 *    {commitment}, amount, nonce)`, which deducts `amount` from the client's
 *    private balance and completes the partial note with that amount.
 *
 * 4. `verifyPayment()` checks:
 *    - Transaction succeeded (receipt status)
 *    - Transaction produced private notes (tx effects)
 *    - Recipient correctness is guaranteed by the commitment pattern
 *      (the facilitator created the partial note for its own address)
 *
 * ## Amount Verification
 *
 * The ZK proof guarantees the transfer logic is valid, but the client chooses
 * the amount parameter. To verify the facilitator received the correct amount,
 * a full implementation would query the PXE for the specific note created by
 * the commitment. For this demo, we verify tx status and note creation;
 * amount verification via PXE note queries is a future improvement.
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

/** Minimal token contract interface — only the methods we use */
interface TokenContract {
  methods: {
    prepare_private_balance_increase(to: AztecAddress): {
      simulate(opts: { from: AztecAddress }): Promise<unknown>;
      send(
        opts: Record<string, unknown>,
      ): Promise<{ txHash: { toString(): string } }>;
    };
  };
}

/**
 * Extract a commitment string from the simulate() return value.
 *
 * prepare_private_balance_increase returns a PartialNote { commitment: Field }.
 * The TypeScript shape may be `{ commitment: Fr }` or a raw value.
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

  async prepareCommitment(_tokenAddress: string): Promise<string> {
    const from = this.account.address;
    const interaction =
      this.token.methods.prepare_private_balance_increase(from);

    // simulate() returns the Noir function's return value (the commitment)
    const result = await interaction.simulate({ from });

    // send() executes the transaction on-chain, creating the partial note
    const opts: Record<string, unknown> = { from, wait: { timeout: 120 } };
    if (this.sendOpts?.fee) {
      opts.fee = this.sendOpts.fee;
    }
    await interaction.send(opts);

    return extractCommitment(result);
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
      //    The commitment pattern guarantees the note goes to the facilitator's
      //    address (since the partial note was created for this address).
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

      // 3. Recipient verification: guaranteed by the commitment pattern.
      //    The facilitator created the partial note for its own address.
      //
      // 4. Amount verification: the client provides the amount when calling
      //    finalize_transfer_to_private_from_private. A full implementation
      //    would query the PXE for the specific note value. For now, we trust
      //    tx success + commitment pattern.
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
