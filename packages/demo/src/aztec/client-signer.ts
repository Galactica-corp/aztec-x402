/**
 * Real ClientAztecSigner — wraps an Aztec AccountManager and the
 * Aztec Token contract to complete commitment-based private transfers.
 *
 * ## v4.1.0 Offchain Delivery
 *
 * On v4.1.0+, the server returns an offchainMessage alongside the commitment.
 * The client must call `processOffchainMessage()` to register the partial note
 * in its PXE via `offchain_receive()` before finalizing the transfer.
 *
 * Flow:
 * 1. Server returns { commitment, offchainMessage, prepareTxHash }
 * 2. Client calls processOffchainMessage() → offchain_receive() on token contract
 * 3. Client calls finalizePayment() → transfer_private_to_commitment()
 */
import type { ClientAztecSigner } from "@galactica-net/x402-core";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { TxHash, TxStatus } from "@aztec/aztec.js/tx";

interface AztecAccount {
  address: AztecAddress;
}

interface OffchainReceiveInput {
  ciphertext: unknown[];
  recipient: string;
  tx_hash: unknown;
  anchor_block_timestamp: number;
}

interface SendResult {
  receipt?: { txHash?: { toString(): string } };
  txHash?: { toString(): string };
}

interface TokenContract {
  methods: {
    transfer_private_to_commitment(
      from: AztecAddress,
      commitment: unknown,
      amount: bigint,
      nonce: unknown,
    ): {
      simulate(opts: { from: AztecAddress }): Promise<unknown>;
      send(opts: Record<string, unknown>): Promise<SendResult>;
    };
    offchain_receive?(
      messages: OffchainReceiveInput[],
    ): {
      simulate(opts: { from: AztecAddress }): Promise<unknown>;
    };
  };
}

function toFieldLike(value: unknown): unknown {
  if (typeof value === "bigint" || typeof value === "number" || Buffer.isBuffer(value)) {
    return value;
  }
  if (value != null && typeof value === "object" && "toField" in value) {
    return value;
  }
  return String(value);
}

function normalizeCiphertext(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload.map(toFieldLike);
  if (typeof payload === "string") {
    if (payload.includes(",")) return payload.split(",").map((field) => field.trim()).filter(Boolean);
    return payload ? [payload] : [];
  }
  return payload == null ? [] : [toFieldLike(payload)];
}

function extractTxHash(sendResult: SendResult): string {
  const txHash = sendResult.receipt?.txHash ?? sendResult.txHash;
  if (!txHash) {
    throw new Error("send() result did not include a transaction hash");
  }
  return txHash.toString();
}

export class RealClientAztecSigner implements ClientAztecSigner {
  constructor(
    private readonly account: AztecAccount,
    private readonly token: TokenContract,
    private readonly sendOpts?: { fee?: unknown },
  ) {}

  async getAddress(): Promise<string> {
    return this.account.address.toString();
  }

  /**
   * Process an offchain message from the server (v4.1.0+).
   *
   * Calls `offchain_receive()` on the token contract to register the
   * partial note in the client's PXE. This is required before the client
   * can see and finalize the partial note.
   */
  async processOffchainMessage(
    _tokenAddress: string,
    offchainMessage: string,
    prepareTxHash: string,
  ): Promise<void> {
    if (!this.token.methods.offchain_receive) {
      // v4.0.x token contract — offchain_receive not available, skip
      return;
    }

    const clientAddr = this.account.address;

    // Parse the serialized offchain messages from the server
    let messages: Array<{
      payload?: unknown;
      ciphertext?: unknown;
      recipient?: string;
      anchorBlockTimestamp?: number;
    }>;
    try {
      messages = JSON.parse(offchainMessage);
    } catch {
      // Not valid JSON — may be a raw payload, wrap it
      messages = [{ payload: offchainMessage }];
    }

    // Build offchain_receive input
    const receiveInputs: OffchainReceiveInput[] = messages.map((msg) => ({
      ciphertext: normalizeCiphertext(msg.payload ?? msg.ciphertext),
      recipient: msg.recipient ?? clientAddr.toString(),
      tx_hash: TxHash.fromString(prepareTxHash).hash,
      anchor_block_timestamp: msg.anchorBlockTimestamp ?? 0,
    }));

    await this.token.methods.offchain_receive(receiveInputs).simulate({
      from: clientAddr,
    });
  }

  async finalizePayment(
    _tokenAddress: string,
    commitment: string,
    amount: bigint,
  ): Promise<string> {
    const from = this.account.address;

    // Complete the transfer using the server-provided commitment.
    // The server already called initialize_transfer_commitment(serverAddr, clientAddr),
    // so this commitment is bound to the server's address as recipient.
    const interaction =
      this.token.methods.transfer_private_to_commitment(from, commitment, amount, 0);
    await interaction.simulate({ from });

    const opts: Record<string, unknown> = {
      from,
      wait: { timeout: 240, waitForStatus: TxStatus.CHECKPOINTED },
    };
    if (this.sendOpts?.fee) {
      opts.fee = this.sendOpts.fee;
    }
    const receipt = await interaction.send(opts);
    return extractTxHash(receipt);
  }
}
