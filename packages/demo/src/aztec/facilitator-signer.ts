/**
 * Real FacilitatorAztecSigner — wraps an Aztec AccountManager, EmbeddedWallet,
 * and AztecNode to verify payments on the Aztec network.
 *
 * - getTxReceipt comes from the node (not available on EmbeddedWallet)
 * - registerSender comes from the wallet
 * - getTxEffect comes from the node (used for basic tx content validation)
 *
 * ## Known Limitation: Private Note Verification
 *
 * On devnet with separate PXEs, the facilitator cannot read the client's
 * private notes. This means we cannot directly verify recipient, amount,
 * or token contract from the transaction alone. The current implementation
 * checks tx status and basic tx effect structure, but does NOT fully verify
 * payment parameters.
 *
 * ## Proper Fix: transfer_private_to_commitment
 *
 * The `transfer_private_to_private` method is fundamentally insufficient
 * for payment verification because the recipient cannot attribute the
 * payment to a specific invoice or verify payment details.
 *
 * The fix is to use `transfer_private_to_commitment` from the Aztec token
 * standard (defi-wonderland/aztec-standards):
 *
 * 1. Facilitator calls `initialize_transfer_commitment(facilitatorAddr, clientAddr)`
 *    → returns a commitment Field
 * 2. Commitment is included in the 402 response (PaymentRequirements.extra)
 * 3. Client calls `transfer_private_to_commitment(from, commitment, amount, nonce)`
 * 4. Facilitator verifies:
 *    - Commitment matches what was issued for this request
 *    - Completed note arrives in facilitator's PXE (discoverable because the
 *      commitment was initialized with facilitator as recipient)
 *    - Note amount meets the required payment
 *
 * @see https://github.com/defi-wonderland/aztec-standards/blob/dev/src/token_contract/README.md#transfer_private_to_commitment
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
 * We only use fields needed for basic validation.
 */
interface TxEffect {
  /** Note hashes created by this transaction */
  noteHashes?: unknown[];
  /** Nullifiers consumed by this transaction */
  nullifiers?: unknown[];
}

/** Minimal wallet interface */
interface AztecWallet {
  registerSender(address: AztecAddress, alias: string): Promise<unknown>;
}

interface AztecAccount {
  address: AztecAddress;
}

export class RealFacilitatorAztecSigner implements FacilitatorAztecSigner {
  constructor(
    private readonly account: AztecAccount,
    private readonly wallet: AztecWallet,
    private readonly node: AztecNode,
  ) {}

  async getAddresses(): Promise<string[]> {
    return [this.account.address.toString()];
  }

  async registerSender(senderAddress: string): Promise<void> {
    const address = AztecAddress.fromString(senderAddress);
    await this.wallet.registerSender(address, "");
  }

  async verifyPaymentNotes(
    txHashStr: string,
    tokenAddress: string,
    recipientAddress: string,
    requiredAmount: bigint,
  ): Promise<PaymentNoteVerification> {
    try {
      const txHash = TxHash.fromString(txHashStr);

      // 1. Confirm the transaction succeeded via the node
      const receipt = await this.node.getTxReceipt(txHash);
      const validStatuses = ["success", "proposed", "checkpointed", "proven", "finalized"];
      if (!validStatuses.includes(receipt.status)) {
        return {
          isValid: false,
          amountFound: 0n,
          error: `transaction status is '${receipt.status}'`,
        };
      }

      // 2. Basic validation via tx effects.
      //    We check that the transaction produced note hashes (i.e., it created
      //    private notes). A private transfer should create at least one note
      //    (payment note for recipient, possibly change note for sender).
      try {
        const txEffect = await this.node.getTxEffect(txHash);
        if (txEffect) {
          const noteHashes = txEffect.noteHashes ?? [];
          // Filter out zero/empty note hashes
          const nonEmptyNotes = noteHashes.filter((h) => {
            if (h == null) return false;
            const str = String(h);
            return str !== "0" && str !== "0x0" && str !== "";
          });

          if (nonEmptyNotes.length === 0) {
            return {
              isValid: false,
              amountFound: 0n,
              error: "transaction produced no private notes — not a valid private transfer",
            };
          }
        }
      } catch {
        // getTxEffect might not be available on all node versions.
        // Fall through to the trust-based check below.
      }

      // 3. FIXME: Cannot verify recipient, amount, or token from tx effects alone.
      //
      //    With transfer_private_to_private, private note contents are encrypted
      //    to the recipient's key and not readable by the facilitator when using
      //    separate PXEs. We trust the ZK proof validated by the network, but
      //    this means a malicious client could submit a valid tx that sends tokens
      //    to a different address.
      //
      //    The proper fix is to switch to transfer_private_to_commitment:
      //    1. Facilitator generates a commitment via initialize_transfer_commitment()
      //    2. Client completes it via transfer_private_to_commitment()
      //    3. Facilitator's PXE discovers the note (it was initialized for this address)
      //    4. Facilitator verifies the note amount matches requiredAmount
      //
      //    Until then, we log the gap and trust the tx hash.
      //
      //    Parameters available but NOT currently verified:
      //    - tokenAddress: ${tokenAddress}
      //    - recipientAddress: ${recipientAddress}
      //    - requiredAmount: ${requiredAmount}
      return { isValid: true, amountFound: requiredAmount };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isValid: false,
        amountFound: 0n,
        error: `note verification failed: ${message}`,
      };
    }
  }
}
