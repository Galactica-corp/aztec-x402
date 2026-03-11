/**
 * Real FacilitatorAztecSigner — wraps an Aztec AccountWallet and PXE
 * to verify payments via per-transaction note lookup on the Aztec network.
 */
import type {
  FacilitatorAztecSigner,
  PaymentNoteVerification,
} from "@aztech-x402/core";
import { AztecAddress, TxHash, Fr } from "@aztec/aztec.js";

/** Minimal PXE interface — only the methods we use */
interface AztecPXE {
  registerSender(address: AztecAddress): Promise<unknown>;
  getTxReceipt(txHash: TxHash): Promise<{ status: string }>;
  getNotes(filter: {
    txHash: TxHash;
    contractAddress: AztecAddress;
    storageSlot: Fr;
    recipient: AztecAddress;
  }): Promise<{ items: Fr[] }[]>;
}

interface AztecWallet {
  getAddress(): AztecAddress;
}

/** Token contract's private balances storage slot (standard @aztec/noir-contracts.js Token) */
const PRIVATE_BALANCES_SLOT = new Fr(3n);

export class RealFacilitatorAztecSigner implements FacilitatorAztecSigner {
  constructor(
    private readonly wallet: AztecWallet,
    private readonly pxe: AztecPXE,
  ) {}

  async getAddresses(): Promise<string[]> {
    return [this.wallet.getAddress().toString()];
  }

  async registerSender(senderAddress: string): Promise<void> {
    const address = AztecAddress.fromString(senderAddress);
    await this.pxe.registerSender(address);
  }

  async verifyPaymentNotes(
    txHashStr: string,
    tokenAddress: string,
    recipientAddress: string,
    requiredAmount: bigint,
  ): Promise<PaymentNoteVerification> {
    try {
      const txHash = TxHash.fromString(txHashStr);

      // 1. Confirm the transaction succeeded
      const receipt = await this.pxe.getTxReceipt(txHash);
      if (receipt.status !== "success") {
        return {
          isValid: false,
          amountFound: 0n,
          error: `transaction status is '${receipt.status}'`,
        };
      }

      // 2. Get notes created for recipient in this specific tx
      const recipient = AztecAddress.fromString(recipientAddress);
      const contract = AztecAddress.fromString(tokenAddress);
      const notes = await this.pxe.getNotes({
        txHash,
        contractAddress: contract,
        storageSlot: PRIVATE_BALANCES_SLOT,
        recipient,
      });

      // 3. Sum amounts — UintNote has 1 Fr field (the amount) at items[0]
      let total = 0n;
      for (const note of notes) {
        total += note.items[0].toBigInt();
      }

      // 4. Verify sum meets requirement
      if (total < requiredAmount) {
        return {
          isValid: false,
          amountFound: total,
          error: `insufficient payment: found ${total}, need ${requiredAmount}`,
        };
      }

      return { isValid: true, amountFound: total };
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
