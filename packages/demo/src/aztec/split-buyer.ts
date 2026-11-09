/**
 * The buyer's side of a split payment with an L1 key in hand (demo client and
 * tests; the agent CLI has the user sign in their own wallet instead).
 *
 * The offered terms are checked against the buyer's own manifest, never
 * trusted: a server naming another chain or portal is refused. The amount is
 * the smallest offered denomination the SDK allows, never the bare price.
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { AztecAddress as Address } from "@aztec-labs/aztec.js/addresses";
import { Fr } from "@aztec-labs/aztec.js/fields";
import type { AztecNode } from "@aztec-labs/aztec.js/node";
import {
  DENOMINATIONS,
  confirmDeposit,
  encodeTicket,
  ensurePermit2Allowance,
  prepareSplitDeposit,
  splitProofOf,
  submitDeposit,
  syncMerchantList,
  type BridgeManifest,
  type ClaimTicket,
  type MerchantList,
} from "@galactica-net/inference-money-core";
import { writeEvm, type L1Signer } from "@galactica-net/inference-money-core/deploy";
import type { SplitPaymentProof, SplitTerms } from "@galactica-net/x402-core";
import { erc20Abi, maxUint256 } from "viem";

export interface SplitPayment {
  ticket: ClaimTicket;
  proof: SplitPaymentProof;
  amount: bigint;
}

/** The deposit amount for these terms: `wanted` if offered and allowed, else the smallest denomination ≥ the price. */
export function chooseDenomination(terms: SplitTerms, wanted?: bigint): bigint {
  const offered = terms.denominations.map(BigInt).filter((d) => DENOMINATIONS.includes(d) && d >= BigInt(terms.price));
  if (wanted !== undefined) {
    if (!offered.includes(wanted)) throw new Error(`${wanted} is not an offered deposit amount (${offered.join(", ")}).`);
    return wanted;
  }
  const smallest = offered.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0];
  if (smallest === undefined) throw new Error("The merchant offers no deposit amount this SDK can build.");
  return smallest;
}

/** Refuses terms for another bridge than the buyer's own. */
export function assertTermsMatch(terms: SplitTerms, m: BridgeManifest): void {
  if (terms.chainId !== m.l1.chainId || terms.portal.toLowerCase() !== m.l1.portal.toLowerCase()) {
    throw new Error(`The merchant's split terms name chain ${terms.chainId} portal ${terms.portal}, not this bridge's.`);
  }
}

export async function paySplit(o: {
  l1: L1Signer;
  m: BridgeManifest;
  node: AztecNode;
  terms: SplitTerms & { paymentRef: string };
  /** The Aztec account that collects the change; its first collection binds it to this L1 key. */
  buyer: AztecAddress;
  amount?: bigint;
  /** A merchant list to judge the merchant by (default: synced now). */
  list?: MerchantList;
  /** Durable sink for the draft and the ticket: they hold the only copy of the change's salt. */
  keep?: (kind: "draft" | "claim", json: string) => void;
}): Promise<SplitPayment> {
  assertTermsMatch(o.terms, o.m);
  const amount = chooseDenomination(o.terms, o.amount);
  const depositor = o.l1.account.address;
  await ensurePermit2Allowance({
    allowance: () =>
      o.l1.publicClient.readContract({ address: o.m.l1.usdc, abi: erc20Abi, functionName: "allowance", args: [depositor, o.m.l1.permit2] }),
    approveMax: async () =>
      (await writeEvm(o.l1, "Permit2 approval", o.m.l1.usdc, [...erc20Abi], "approve", [o.m.l1.permit2, maxUint256])).transactionHash,
    waitReceipt: (hash) => o.l1.publicClient.waitForTransactionReceipt({ hash }),
    needed: amount,
  });
  const l1Now = (await o.l1.publicClient.getBlock()).timestamp;
  const token = Address.fromStringUnsafe(o.m.l2.token.address);
  const draft = await prepareSplitDeposit(
    {
      amount,
      merchant: Address.fromStringUnsafe(o.terms.merchant),
      price: BigInt(o.terms.price),
      paymentRef: Fr.fromHexString(o.terms.paymentRef),
      buyer: o.buyer,
    },
    o.m,
    () => l1Now,
    o.list ?? (await syncMerchantList(o.node, token)),
  );
  o.keep?.("draft", encodeTicket("draft", draft));
  const ctx = { publicClient: o.l1.publicClient, walletClient: o.l1.walletClient, account: depositor };
  await submitDeposit(draft, ctx, o.m, o.node);
  const ticket = await confirmDeposit(draft, ctx, o.m);
  o.keep?.("claim", encodeTicket("claim", ticket));
  return { ticket, proof: splitProofOf(ticket.draft), amount };
}
