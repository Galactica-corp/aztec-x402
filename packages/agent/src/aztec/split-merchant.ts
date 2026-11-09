/**
 * The merchant's side of split deposits (inference-money's one-step payment
 * from Ethereum): what to offer, how to check a buyer's deposit on L1, and how
 * to claim the price on Aztec afterwards.
 *
 * Rules the SDK leaves to the integration (proposal concerns 2–4):
 * - A deposit made before the merchant's listing landed on Aztec can be
 *   returned to the buyer after the merchant served it. So the listing's
 *   block time is read once (from its `MerchantAdded` event) and a deposit
 *   whose L1 block is not later than it is refused.
 * - The merchant serves on L1 confirmation and is exposed to a reorg or a
 *   bridge pause until its claim lands; above `finalizedAbove` it waits for
 *   the deposit to be finalized on L1.
 * - A merchant whose switch-off is scheduled loses unclaimed deposits once it
 *   takes effect, so split is only offered while the merchant stays one for
 *   the longest switch-off delay.
 *
 * This module loads the SDK; import it only when split payments are on.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { getPublicEvents } from "@aztec-labs/aztec.js/events";
import { BlockNumber, Fr } from "@aztec-labs/aztec.js/fields";
import type { AztecNode } from "@aztec-labs/aztec.js/node";
import {
  DENOMINATIONS,
  MERCHANT_MAX_DELAY,
  MessageNotConsumableError,
  SPLIT_CONFIRMATIONS,
  SplitProofRefusedError,
  claimSplit,
  merchantStatus,
  syncMerchantList,
  tokenEvent,
  verifySplitDeposit,
  waitSplitClaimable,
  type BridgeManifest,
  type ClaimResult,
  type FeeChoice,
  type SplitClaim,
} from "@galactica-net/inference-money-core";
import type { ModeVerification, SplitPaymentProof, SplitTerms } from "@galactica-net/x402-core";
import { z } from "zod";
import type { SplitClaimer } from "./merchant-jobs.js";
import type { PXEWallet } from "./pxe-wallet.js";

type Hex = `0x${string}`;

/** The L1 reads a merchant needs: the SDK's, and block lookups for the listing guard and finality. */
export type SplitL1Client = Parameters<typeof verifySplitDeposit>[0] & {
  getBlock(args: { blockNumber: bigint } | { blockTag: "finalized" }): Promise<{ number: bigint | null; timestamp: bigint }>;
};

export interface SplitMerchantOptions {
  manifest: BridgeManifest;
  l1: SplitL1Client;
  node: AztecNode;
  wallet: PXEWallet;
  merchant: AztecAddress;
  /** L1 blocks a deposit must be deep before serving (default: the SDK's, 2). */
  confirmations?: number;
  /** Prices at or above this many base units wait for the deposit to be finalized on L1. */
  finalizedAbove?: bigint;
  /** Who pays the claim's fee (default: the sponsor). */
  fee?: FeeChoice;
  log?: (message: string) => void;
}

/** What the merchant keeps per served split payment: the claim, and the buyer's proof to rebuild it after an L1 reorg. */
const StoredClaimSchema = z.object({
  v: z.literal(1),
  proof: z.object({
    l1TxHash: z.string(),
    price: z.string(),
    paymentRef: z.string(),
    changeCommitment: z.string(),
    salt: z.string(),
  }),
  claim: z.object({
    amount: z.string(),
    depositor: z.string(),
    leafIndex: z.string(),
    messageHash: z.string(),
    merchant: z.string(),
    price: z.string(),
    paymentRef: z.string(),
    changeCommitment: z.string(),
    salt: z.string(),
  }),
});
export type StoredClaim = z.infer<typeof StoredClaimSchema>;

const hex = (value: string): Hex => {
  if (!/^0x[0-9a-fA-F]*$/.test(value)) throw new Error(`not hex: ${value}`);
  return `0x${value.slice(2)}`;
};

export function serializeSplitClaim(claim: SplitClaim, proof: SplitPaymentProof): string {
  const stored: StoredClaim = {
    v: 1,
    proof,
    claim: {
      amount: claim.amount.toString(),
      depositor: claim.depositor,
      leafIndex: claim.leafIndex.toString(),
      messageHash: claim.messageHash,
      merchant: claim.merchant.toString(),
      price: claim.price.toString(),
      paymentRef: claim.paymentRef.toString(),
      changeCommitment: claim.changeCommitment.toString(),
      salt: claim.salt.toString(),
    },
  };
  return JSON.stringify(stored);
}

export function parseSplitClaim(json: string): { claim: SplitClaim; proof: SplitPaymentProof } {
  const { claim: c, proof } = StoredClaimSchema.parse(JSON.parse(json));
  return {
    proof,
    claim: {
      amount: BigInt(c.amount),
      depositor: hex(c.depositor),
      leafIndex: BigInt(c.leafIndex),
      messageHash: hex(c.messageHash),
      merchant: AztecAddress.fromStringUnsafe(c.merchant),
      price: BigInt(c.price),
      paymentRef: Fr.fromHexString(c.paymentRef),
      changeCommitment: Fr.fromHexString(c.changeCommitment),
      salt: Fr.fromHexString(c.salt),
    },
  };
}

/** How a claim attempt ended: claimed, already consumed by someone, or the L1 message not consumable on Aztec yet. */
export type SplitClaimOutcome = ClaimResult | "not-ready";

export class SplitMerchant implements SplitClaimer {
  private listedAt: bigint | undefined;
  private listingCheckedAt = 0;

  private constructor(private readonly opts: SplitMerchantOptions) {}

  /** Reads the merchant's listing time once; a merchant not listed yet is looked up again later. */
  static async create(opts: SplitMerchantOptions): Promise<SplitMerchant> {
    const merchant = new SplitMerchant(opts);
    await merchant.refreshListing();
    return merchant;
  }

  get token(): AztecAddress {
    return AztecAddress.fromStringUnsafe(this.opts.manifest.l2.token.address);
  }

  /** The Aztec block time at which the merchant's listing landed, or undefined while it is not listed. */
  get listingTime(): bigint | undefined {
    return this.listedAt;
  }

  private async refreshListing(): Promise<void> {
    this.listingCheckedAt = Date.now();
    const added = await tokenEvent("MerchantAdded");
    let afterEvent: Parameters<typeof getPublicEvents>[2]["afterEvent"];
    do {
      const page = await getPublicEvents<{ account: AztecAddress }>(this.opts.node, added, {
        contractAddress: this.token,
        afterEvent,
      });
      const mine = page.events.find((e) => AztecAddress.fromStringUnsafe(e.event.account.toString()).equals(this.opts.merchant));
      if (mine) {
        const block = await this.opts.node.getBlockData(BlockNumber(Number(mine.metadata.l2BlockNumber)));
        if (!block) throw new Error(`The block of the merchant's listing (${mine.metadata.l2BlockNumber}) is unknown to the node.`);
        this.listedAt = block.header.globalVariables.timestamp;
        return;
      }
      afterEvent = page.nextCursor;
    } while (afterEvent);
  }

  /**
   * The split terms to offer at `price`, or undefined while split payments
   * cannot be taken: the merchant is not listed (or its listing is too new to
   * be found), or it will not stay a merchant for the longest switch-off
   * delay. Only denominations of at least the price are offered.
   */
  async terms(price: bigint): Promise<SplitTerms | undefined> {
    if (this.listedAt === undefined && Date.now() - this.listingCheckedAt > 60_000) await this.refreshListing();
    if (this.listedAt === undefined) return undefined;
    const list = await syncMerchantList(this.opts.node, this.token);
    const now = merchantStatus(list, this.opts.merchant).merchant;
    const staying = merchantStatus(list, this.opts.merchant, list.at + MERCHANT_MAX_DELAY).merchant;
    if (!now || !staying) return undefined;
    const denominations = DENOMINATIONS.filter((d) => d >= price).map((d) => d.toString());
    if (denominations.length === 0) return undefined;
    return {
      merchant: this.opts.merchant.toString(),
      price: price.toString(),
      denominations,
      chainId: this.opts.manifest.l1.chainId,
      portal: this.opts.manifest.l1.portal,
    };
  }

  /**
   * Checks a buyer's deposit for these terms. On success `splitClaim` holds
   * what the merchant persists before serving. A deposit not deep enough yet
   * (or not finalized, above `finalizedAbove`) is retryable; one made before
   * the listing landed is refused for good.
   */
  async verify(proof: SplitPaymentProof, expected: { paymentRef: string; price: bigint }): Promise<ModeVerification> {
    const { l1, manifest, merchant } = this.opts;
    let claim: SplitClaim;
    try {
      claim = await verifySplitDeposit(
        l1,
        manifest,
        merchant,
        { ...proof, l1TxHash: hex(proof.l1TxHash) },
        { paymentRef: Fr.fromHexString(expected.paymentRef), price: expected.price },
        { confirmations: this.opts.confirmations ?? SPLIT_CONFIRMATIONS },
      );
    } catch (error) {
      if (error instanceof SplitProofRefusedError) {
        return { isValid: false, reason: error.reason, error: error.message, retryable: error.reason === "unconfirmed" };
      }
      throw error;
    }

    const receipt = await l1.getTransactionReceipt({ hash: hex(proof.l1TxHash) });
    const block = await l1.getBlock({ blockNumber: receipt.blockNumber });
    if (this.listedAt === undefined || block.timestamp <= this.listedAt) {
      return {
        isValid: false,
        reason: "before-listing",
        error: "the deposit was made before this merchant's listing landed, so it could be returned to the buyer",
      };
    }
    if (this.opts.finalizedAbove !== undefined && expected.price >= this.opts.finalizedAbove) {
      const finalized = (await l1.getBlock({ blockTag: "finalized" })).number;
      if (finalized === null || finalized < receipt.blockNumber) {
        return { isValid: false, reason: "unconfirmed", error: "waiting for the deposit to be finalized on L1", retryable: true };
      }
    }
    return {
      isValid: true,
      amountFound: claim.price,
      transaction: proof.l1TxHash,
      splitClaim: serializeSplitClaim(claim, proof),
    };
  }

  /**
   * One claim attempt (the claim as {@link serializeSplitClaim} wrote it): "not-ready" while the deposit's message is not
   * consumable on Aztec yet (minutes after the L1 deposit). Throws on other
   * failures, `SponsorUnavailableError` included; the caller retries later.
   */
  async claim(claimJson: string): Promise<SplitClaimOutcome> {
    const { claim } = parseSplitClaim(claimJson);
    const { node, wallet, manifest, merchant } = this.opts;
    try {
      await waitSplitClaimable(claim, node, wallet, manifest, merchant, undefined, { attempts: 1, pollMs: 0 });
    } catch (error) {
      if (error instanceof MessageNotConsumableError) return "not-ready";
      throw error;
    }
    return claimSplit(claim, node, wallet, manifest, { from: merchant, fee: this.opts.fee });
  }

  /**
   * The claim rebuilt from the buyer's proof as L1 shows it now: after a
   * reorg re-mined the deposit behind other messages, its leaf and key moved.
   * Undefined when the deposit no longer verifies.
   */
  async rebuild(claimJson: string): Promise<string | undefined> {
    const { proof } = parseSplitClaim(claimJson);
    const result = await this.verify(proof, { paymentRef: proof.paymentRef, price: BigInt(proof.price) });
    return result.isValid ? result.splitClaim : undefined;
  }
}
