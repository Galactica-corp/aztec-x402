import {
  type FacilitatorAztecSigner,
  type AztecNetwork,
  type ExactAztecPayload,
  type ModeVerification,
  type PaymentMode,
  SCHEME,
  CAIP_FAMILY,
  RefAztecPayloadSchema,
  SplitAztecPayloadSchema,
  isValidAztecAddress,
  parseAztecPaymentExtra,
  payloadMode,
} from "@galactica-net/x402-core";
import type {
  SchemeNetworkFacilitator,
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
  FacilitatorContext,
  Network,
  PaymentOffer,
} from "../../x402-types.js";

/**
 * Parse the generic payload record into an ExactAztecPayload.
 * No type assertions — we extract and coerce each field explicitly.
 */
function parseAztecPayload(raw: Record<string, unknown>): ExactAztecPayload {
  return {
    senderAddress: String(raw.senderAddress ?? ""),
    correlationId: String(raw.correlationId ?? ""),
    txHash: String(raw.txHash ?? ""),
    timestamp: String(raw.timestamp ?? ""),
  };
}

interface PendingCommitment {
  senderAddress: string;
  tokenAddress: string;
  nonce?: string;
  expiresAt: number;
}

interface PreparePaymentOptions {
  nonce?: string;
  timeoutMs?: number;
  createdAt?: number;
}

const DEFAULT_COMMITMENT_TIMEOUT_MS = 120_000;

function normalizeAddress(address: string): string {
  return address.toLowerCase();
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

function isRetryableVerificationError(reason: string): boolean {
  return (
    reason.startsWith("completion log lookup failed") ||
    reason.startsWith("no completion log found for commitment") ||
    reason.startsWith("transaction effects unavailable") ||
    reason.startsWith("amount verification failed") ||
    reason.startsWith("verification error:") ||
    reason.startsWith("verification failed:")
  );
}

/**
 * Facilitator-side x402 scheme for Aztec.
 *
 * The server creates commitments for its own address using the Aztec
 * token contract's initialize_transfer_commitment(serverAddr).
 * This provides structural recipient verification — the partial note is
 * bound to the server's address, so the client can only transfer TO the server.
 *
 * Flow:
 * 1. Client announces its address (prepare phase)
 * 2. Server creates commitment via preparePayment → returns commitment
 * 3. Client calls transfer_private_to_commitment with the commitment
 * 4. Server verifies tx status + note creation
 *
 * Settlement:
 * For Aztec private transfers, settlement happens at transfer time.
 * The settle method acknowledges the payment and tracks consumed txHashes.
 */
export class ExactAztecFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = SCHEME;
  readonly caipFamily = CAIP_FAMILY;

  private cachedAddresses: string[] = [];
  private consumedTxHashes = new Set<string>();
  private inFlightTxHashes = new Map<string, number>();
  private pendingCommitments = new Map<string, PendingCommitment>();

  constructor(
    private readonly signer: FacilitatorAztecSigner,
    private readonly networks: AztecNetwork[],
  ) {}

  getExtra(_network: Network): Record<string, unknown> | undefined {
    return undefined;
  }

  getSigners(_network: string): string[] {
    return this.cachedAddresses;
  }

  /**
   * Initialize cached addresses. Call this after construction
   * to populate the signer addresses synchronously for getSigners().
   */
  async initialize(): Promise<void> {
    this.cachedAddresses = await this.signer.getAddresses();
  }

  /**
   * Prepare a commitment for a pending payment.
   *
   * Called by the middleware during the prepare phase when the client
   * sends its address. Creates a commitment bound to the facilitator's
   * address with the client as the authorized completer.
   *
   * On v4.1.0+, the signer returns a PrepareCommitmentResult with
   * offchainMessage data. This is passed through to the client so it
   * can call offchain_receive() before finalizing.
   *
   * @param tokenAddress - The token contract address
   * @param completerAddress - The client's Aztec address
   * @returns Extra data containing commitment and optional offchainMessage
   */
  async preparePayment(
    tokenAddress: string,
    completerAddress: string,
    options: PreparePaymentOptions = {},
  ): Promise<Record<string, unknown>> {
    this.sweepExpiredCommitments();

    const result = await this.signer.prepareCommitment(
      tokenAddress,
      completerAddress,
    );

    // Handle both v4.0.x (string) and v4.1.0+ (PrepareCommitmentResult) return types
    let commitment: string;
    let offchainMessage: string | undefined;
    let prepareTxHash: string | undefined;

    if (typeof result === "string") {
      commitment = result;
    } else {
      commitment = result.commitment;
      offchainMessage = result.offchainMessage;
      prepareTxHash = result.prepareTxHash;
    }

    if (!isNonZeroFieldString(commitment)) {
      throw new Error("facilitator returned an invalid commitment");
    }

    const createdAt = options.createdAt ?? Date.now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMITMENT_TIMEOUT_MS;
    this.pendingCommitments.set(commitment, {
      senderAddress: normalizeAddress(completerAddress),
      tokenAddress: normalizeAddress(tokenAddress),
      nonce: options.nonce,
      expiresAt: createdAt + timeoutMs,
    });

    const extra: Record<string, unknown> = { commitment };
    if (offchainMessage) {
      extra.offchainMessage = offchainMessage;
    }
    if (prepareTxHash) {
      extra.prepareTxHash = prepareTxHash;
    }
    return extra;
  }

  /**
   * The `accepts` entries to offer for one 402: `ref` when the signer takes
   * private payments in `asset`, `split` when it also has split terms for
   * this price now, and `commitment` always.
   */
  async offerPayment(
    asset: string,
    price: string,
    modes: ReadonlyArray<PaymentMode>,
    paymentRef: string,
  ): Promise<PaymentOffer> {
    const available = this.signer.paymentModes
      ? new Set(await this.signer.paymentModes(asset, [...modes]))
      : new Set<PaymentMode>(["commitment"]);
    const offers: PaymentOffer["offers"] = [];
    for (const mode of modes) {
      if (!available.has(mode)) continue;
      if (mode === "commitment") {
        offers.push({ mode, extra: { mode } });
      } else if (mode === "ref" && this.signer.receiveRefPayment) {
        offers.push({ mode, extra: { mode, paymentRef } });
      } else if (mode === "split" && this.signer.verifySplitDeposit && this.signer.splitTerms) {
        const terms = await this.signer.splitTerms(asset, BigInt(price));
        if (terms) offers.push({ mode, extra: { mode, paymentRef, ...terms } });
      }
    }
    return { offers };
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    _context?: FacilitatorContext,
  ): Promise<VerifyResponse> {
    const mode = payloadMode(payload.payload);
    if (mode === "ref" || mode === "split") {
      return this.verifyMode(mode, payload, requirements);
    }
    const aztecPayload = parseAztecPayload(payload.payload);
    const extra = parseAztecPaymentExtra(requirements.extra);
    const commitment = extra.commitment;

    this.sweepExpiredCommitments();

    const fail = (
      invalidReason: string,
      invalidMessage: string,
      consumeCommitment = true,
      retryable = false,
    ): VerifyResponse => {
      if (commitment && consumeCommitment) {
        this.pendingCommitments.delete(commitment);
      }
      return {
        isValid: false,
        invalidReason,
        invalidMessage,
        payer: aztecPayload.senderAddress,
        ...(retryable ? { extensions: { retryable: true } } : {}),
      };
    };

    // 1. Validate payload structure
    const validationError = this.validatePayload(aztecPayload);
    if (validationError) {
      return fail(
        validationError,
        `Payment payload validation failed: ${validationError}`,
      );
    }

    const txHash = aztecPayload.txHash;

    // 2. Reject consumed payments (non-retryable) and in-flight payments (retryable)
    if (this.consumedTxHashes.has(txHash)) {
      return fail(
        "payment already used",
        "This payment has already been consumed.",
        true,
      );
    }

    if (this.inFlightTxHashes.has(txHash)) {
      return fail(
        "payment verification in progress",
        "This payment is already being verified.",
        false,
        true,
      );
    }

    // 3. Validate that the commitment was issued by this facilitator
    if (!commitment || !isNonZeroFieldString(commitment)) {
      return fail(
        "invalid or missing commitment",
        "Payment commitment is missing or malformed.",
      );
    }

    const pending = this.pendingCommitments.get(commitment);
    if (!pending) {
      return fail(
        "invalid or missing commitment",
        "Payment commitment was not issued by this facilitator or has expired.",
      );
    }

    if (Date.now() > pending.expiresAt) {
      return fail(
        "expired commitment",
        "Payment commitment has expired.",
      );
    }

    if (pending.senderAddress !== normalizeAddress(aztecPayload.senderAddress)) {
      return fail(
        "sender does not match prepared commitment",
        "Payment sender does not match the address used during prepare.",
      );
    }

    if (pending.tokenAddress !== normalizeAddress(requirements.asset)) {
      return fail(
        "asset does not match prepared commitment",
        "Payment asset does not match the token used during prepare.",
      );
    }

    if (pending.nonce && pending.nonce !== extra.nonce) {
      return fail(
        "nonce does not match prepared commitment",
        "Payment nonce does not match the nonce used during prepare.",
      );
    }

    this.inFlightTxHashes.set(txHash, pending.expiresAt);

    try {
      const timeoutMs = Math.max(1, pending.expiresAt - Date.now());
      const verification = await withTimeout(
        this.signer.verifyPayment(
          txHash,
          requirements.asset,
          BigInt(requirements.amount),
          commitment,
        ),
        timeoutMs,
        "verification timed out",
      );

      if (!verification.isValid) {
        const error = verification.error ?? "payment verification failed";
        const retryable = isRetryableVerificationError(error);
        return fail(
          error,
          `Payment verification failed: ${error}`,
          !retryable,
          retryable,
        );
      }

      return {
        isValid: true,
        payer: aztecPayload.senderAddress,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(
        `verification error: ${message}`,
        `Failed to verify payment: ${message}`,
        false,
        true,
      );
    } finally {
      this.inFlightTxHashes.delete(txHash);
    }
  }

  /**
   * Verifies a `ref` or `split` payment against the reference and price in
   * `requirements` (set by the server from what it issued, not from the
   * client). Whether the reference was served already is the server's to
   * track: this only checks the payment.
   */
  private async verifyMode(
    mode: "ref" | "split",
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const fail = (reason: string, message: string, retryable = false): VerifyResponse => ({
      isValid: false,
      invalidReason: reason,
      invalidMessage: message,
      ...(retryable ? { extensions: { retryable: true } } : {}),
    });
    const paymentRef = parseAztecPaymentExtra(requirements.extra).paymentRef;
    if (!paymentRef) return fail("missing payment reference", "The server issued no reference for this payment.");
    const expected = { paymentRef, price: BigInt(requirements.amount) };

    let result: ModeVerification;
    try {
      if (mode === "ref") {
        if (!this.signer.receiveRefPayment) return fail("unsupported mode", "This facilitator takes no ref payments.");
        const parsed = RefAztecPayloadSchema.safeParse(payload.payload);
        if (!parsed.success) return fail("malformed", "Ref payment payload is malformed.");
        if (parsed.data.paymentRef !== paymentRef) return fail("malformed", "The proof names another reference.");
        const { mode: _mode, ...proof } = parsed.data;
        result = await this.signer.receiveRefPayment(requirements.asset, proof, expected);
      } else {
        if (!this.signer.verifySplitDeposit) return fail("unsupported mode", "This facilitator takes no split payments.");
        const parsed = SplitAztecPayloadSchema.safeParse(payload.payload);
        if (!parsed.success) return fail("malformed", "Split payment payload is malformed.");
        if (parsed.data.paymentRef !== paymentRef || BigInt(parsed.data.price) !== expected.price) {
          return fail("malformed", "The proof names other terms than this payment's.");
        }
        const { mode: _mode, ...proof } = parsed.data;
        result = await this.signer.verifySplitDeposit(requirements.asset, proof, expected);
      }
    } catch (error) {
      // An unexpected failure (node down, RPC error) says nothing about the payment: let the buyer retry.
      const message = error instanceof Error ? error.message : String(error);
      return fail(`verification error: ${message}`, `Failed to verify payment: ${message}`, true);
    }

    if (!result.isValid) {
      const reason = result.reason ?? "payment verification failed";
      return fail(reason, `Payment verification failed: ${result.error ?? reason}`, result.retryable === true);
    }
    const extensions: Record<string, unknown> = {};
    if (result.splitClaim) extensions.splitClaim = result.splitClaim;
    if (result.transaction) extensions.transaction = result.transaction;
    if (result.amountFound !== undefined) extensions.amountFound = result.amountFound.toString();
    return { isValid: true, extensions };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    _context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    const mode = payloadMode(payload.payload);
    if (mode === "ref" || mode === "split") {
      // Settled when paid: the server's store tracks what was served.
      const tx = mode === "ref" ? payload.payload.txHash : payload.payload.l1TxHash;
      return {
        success: true,
        transaction: typeof tx === "string" ? tx : "",
        network: requirements.network,
      };
    }
    const aztecPayload = parseAztecPayload(payload.payload);

    // Consume the commitment and txHash
    const commitment = parseAztecPaymentExtra(requirements.extra).commitment;
    if (commitment) {
      this.pendingCommitments.delete(commitment);
    }
    if (aztecPayload.txHash) {
      this.consumedTxHashes.add(aztecPayload.txHash);
    }

    return {
      success: true,
      payer: aztecPayload.senderAddress,
      transaction: aztecPayload.txHash,
      network: requirements.network,
    };
  }

  private validatePayload(payload: ExactAztecPayload): string | undefined {
    if (!payload.senderAddress) {
      return "missing senderAddress";
    }

    if (!isValidAztecAddress(payload.senderAddress)) {
      return "invalid sender address format";
    }

    if (!payload.correlationId) {
      return "missing correlationId";
    }

    if (!payload.txHash) {
      return "missing txHash";
    }

    return undefined;
  }

  private sweepExpiredCommitments(): void {
    const now = Date.now();
    for (const [commitment, pending] of this.pendingCommitments) {
      if (now > pending.expiresAt) {
        this.pendingCommitments.delete(commitment);
      }
    }
    for (const [txHash, expiresAt] of this.inFlightTxHashes) {
      if (now > expiresAt) {
        this.inFlightTxHashes.delete(txHash);
      }
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
