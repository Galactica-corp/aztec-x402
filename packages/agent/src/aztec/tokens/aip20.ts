/**
 * The upstream aztec-standards Token (AIP-20): anyone may open a request and
 * anyone may pay it.
 *
 * ## Commitment read-back
 *
 * `initialize_transfer_commitment` draws randomness, so the commitment a
 * `simulate()` returns differs from the one the proven tx creates. The merchant
 * therefore reads it from the proven tx's app return values
 * (`PXEWallet.sendTxWithAppReturnValues`), falling back to simulate-then-send
 * for wallets without that method.
 *
 * ## Offchain delivery
 *
 * The opening may hand back offchain messages carrying the partial note. The
 * buyer registers them through `offchain_receive()` before paying.
 */
import type { PrepareCommitmentResult } from "@galactica-net/x402-core";
import { AztecOffchainMessagesSchema, unwrapAztecSdkResult } from "@galactica-net/x402-core";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import type { AztecAddressLike, FieldLike, OptionLike } from "@aztec-labs/aztec.js/abi";
import { toSendOptions } from "@aztec-labs/aztec.js/contracts";
import type { InteractionFeeOptions, SendInteractionOptions, WaitOpts } from "@aztec-labs/aztec.js/contracts";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { TxHash, TxStatus } from "@aztec-labs/aztec.js/tx";
import { isNonZeroFieldString } from "../completion-log.js";
import type { TokenAdapter } from "./adapter.js";

/** Long enough for client-side proving plus a checkpointed block on testnet. */
const TX_TIMEOUT_SECONDS = 240;

interface OffchainMessage {
  payload: unknown;
  recipient?: unknown;
  /** Reported as a bigint; the core schema coerces it to a number. */
  anchorBlockTimestamp?: number | bigint;
}

/**
 * Mirrors the token artifact's `offchain_receive` parameter struct.
 *
 * Fields are `FieldLike`/`AztecAddressLike` rather than anything stringy, so the
 * values are converted at this boundary instead of being handed over as the raw
 * hex strings that come off the wire.
 */
interface OffchainReceiveInput {
  ciphertext: FieldLike[];
  recipient: AztecAddressLike;
  tx_hash: OptionLike<FieldLike>;
  anchor_block_timestamp: number | bigint;
}

/** `send()` returns `{ receipt, offchainEffects, offchainMessages }`; the tx hash is on the receipt. */
interface SendResult {
  receipt?: { txHash?: { toString(): string }; status?: string };
  offchainEffects?: unknown[];
  offchainMessages?: OffchainMessage[];
  appReturnValues?: unknown[];
  txHash?: { toString(): string };
}

/** The part of the generated `TokenContract` this adapter calls. */
export interface Aip20Contract {
  methods: {
    initialize_transfer_commitment(
      to: AztecAddress,
      completer: AztecAddress,
    ): {
      simulate(opts: { from: AztecAddress }): Promise<unknown>;
      request?(opts: Record<string, unknown>): Promise<unknown>;
      send(opts: Record<string, unknown>): Promise<SendResult>;
    };
    transfer_private_to_commitment(
      from: AztecAddress,
      commitment: unknown,
      amount: bigint,
      nonce: unknown,
    ): {
      simulate(opts: { from: AztecAddress }): Promise<unknown>;
      send(opts: Record<string, unknown>): Promise<SendResult>;
    };
    offchain_receive?(messages: OffchainReceiveInput[]): {
      simulate(opts: { from: AztecAddress }): Promise<unknown>;
    };
    balance_of_private(owner: AztecAddress): {
      simulate(opts: { from: AztecAddress }): Promise<unknown>;
    };
  };
}

/**
 * Wallet able to surface the proven tx's private app return values.
 *
 * `ContractFunctionInteraction.wallet` is protected, so the wallet is handed to
 * the adapter explicitly. {@link PXEWallet} implements this.
 */
interface AppReturnValuesWallet {
  sendTxWithAppReturnValues(executionPayload: unknown, opts: unknown): Promise<SendResult>;
}

export interface Aip20Context {
  account: AztecAddress;
  fee?: InteractionFeeOptions;
  wallet?: AppReturnValuesWallet;
}

function extractTxHash(sendResult: SendResult): string {
  const txHash = (sendResult.receipt?.txHash ?? sendResult.txHash)?.toString();
  if (!txHash) {
    throw new Error("send() result did not include a transaction hash");
  }
  return txHash;
}

function normalizeCommitment(value: unknown): string {
  const commitment = value == null ? "" : String(value);
  if (!isNonZeroFieldString(commitment)) {
    throw new Error("invalid commitment returned by token contract");
  }
  return commitment;
}

/** Serialize offchain messages for transport to the buyer. */
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

function hasToField(value: unknown): value is { toField: () => Fr } {
  return typeof value === "object" && value !== null && "toField" in value;
}

function toFieldLike(value: unknown): FieldLike {
  if (typeof value === "bigint" || typeof value === "number" || Buffer.isBuffer(value)) {
    return value;
  }
  if (hasToField(value)) {
    return value;
  }
  // Serialized payloads arrive as hex strings; the encoder needs real fields.
  return Fr.fromString(String(value));
}

function normalizeCiphertext(payload: unknown): FieldLike[] {
  if (Array.isArray(payload)) return payload.map(toFieldLike);
  if (typeof payload === "string") {
    if (payload.includes(",")) {
      return payload
        .split(",")
        .map((field) => field.trim())
        .filter(Boolean)
        .map(toFieldLike);
    }
    return payload ? [toFieldLike(payload)] : [];
  }
  return payload == null ? [] : [toFieldLike(payload)];
}

export class Aip20Token implements TokenAdapter {
  readonly kind = "aip20";

  constructor(
    private readonly ctx: Aip20Context,
    readonly address: AztecAddress,
    private readonly token: Aip20Contract,
  ) {}

  /** The upstream token has no seller rules. */
  async assertCanSell(): Promise<void> {}

  /** The upstream token has no payer rules. */
  async preflight(_payTo: AztecAddress): Promise<void> {}

  async openRequest(completer: AztecAddress): Promise<PrepareCommitmentResult> {
    const merchant = this.ctx.account;

    // Create partial note: to=merchant (recipient), completer=buyer (who will finalize)
    const interaction = this.token.methods.initialize_transfer_commitment(merchant, completer);

    const opts: SendInteractionOptions<WaitOpts> = {
      from: merchant,
      wait: { timeout: TX_TIMEOUT_SECONDS, waitForStatus: TxStatus.CHECKPOINTED },
    };
    if (this.ctx.fee) {
      opts.fee = this.ctx.fee;
    }
    let simulateResult: unknown;
    let sendResult: SendResult;
    const wallet = this.ctx.wallet;
    if (interaction.request && wallet) {
      const executionPayload = await interaction.request(opts);
      sendResult = await wallet.sendTxWithAppReturnValues(executionPayload, toSendOptions(opts));
    } else {
      // Fallback for older wallet implementations.
      simulateResult = await interaction.simulate({ from: merchant });
      sendResult = await interaction.send(opts);
    }

    const appReturnValue = sendResult.appReturnValues?.[0];
    const result: PrepareCommitmentResult = {
      commitment: normalizeCommitment(appReturnValue ?? unwrapAztecSdkResult(simulateResult)),
      prepareTxHash: extractTxHash(sendResult),
    };
    if (sendResult.offchainMessages && sendResult.offchainMessages.length > 0) {
      result.offchainMessage = serializeOffchainMessage(sendResult.offchainMessages);
    }
    return result;
  }

  /**
   * Calls `offchain_receive()` on the token contract to register the partial
   * note in the buyer's PXE, so the buyer can see and finalize it.
   */
  async processOffchainMessage(offchainMessage: string, prepareTxHash: string): Promise<void> {
    if (!this.token.methods.offchain_receive) {
      return;
    }
    const buyer = this.ctx.account;

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

    const receiveInputs: OffchainReceiveInput[] = messages.map((msg) => ({
      ciphertext: normalizeCiphertext(msg.payload ?? msg.ciphertext),
      recipient: msg.recipient ? AztecAddress.fromStringUnsafe(msg.recipient) : buyer,
      tx_hash: TxHash.fromString(prepareTxHash).hash,
      anchor_block_timestamp: msg.anchorBlockTimestamp ?? 0,
    }));

    await this.token.methods.offchain_receive(receiveInputs).simulate({ from: buyer });
  }

  async pay(commitment: string, amount: bigint): Promise<string> {
    const from = this.ctx.account;

    // The merchant already called initialize_transfer_commitment(merchant, buyer),
    // so this commitment is bound to the merchant's address as recipient.
    const interaction = this.token.methods.transfer_private_to_commitment(from, commitment, amount, 0);
    await interaction.simulate({ from });

    const opts: Record<string, unknown> = {
      from,
      wait: { timeout: TX_TIMEOUT_SECONDS, waitForStatus: TxStatus.CHECKPOINTED },
    };
    if (this.ctx.fee) {
      opts.fee = this.ctx.fee;
    }
    return extractTxHash(await interaction.send(opts));
  }

  async privateBalance(): Promise<bigint> {
    const owner = this.ctx.account;
    const value = unwrapAztecSdkResult(await this.token.methods.balance_of_private(owner).simulate({ from: owner }));
    return typeof value === "bigint" ? value : BigInt(String(value));
  }
}
