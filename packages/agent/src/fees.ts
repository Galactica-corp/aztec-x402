/**
 * Who pays the agent's transaction fees.
 *
 * Every Aztec tx names its fee payer in public. Where the network has a
 * sponsor (testnet, local) it pays, and the agent's account stays out of its
 * payments. Mainnet has none: the agent pays from its own Fee Juice and is
 * named as the payer of every payment, and its Fee Juice deposit on L1 links
 * that account to the Ethereum address it came from. Amounts (in ref mode) and
 * merchants stay private, but whether this agent paid does not, so the user
 * opts in once (`config set publicFees true` or AZTEC_X402_PUBLIC_FEES=1)
 * before the agent pays anything that way.
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import type { AztecNode } from "@aztec-labs/aztec.js/node";
import { getFeeJuiceBalance } from "@aztec-labs/aztec.js/utils";
import type { ResolvedContext } from "./config.js";
import { CliError, UsageError } from "./errors.js";

export type FeeMode =
  /** The network's sponsor pays; the agent is not named. */
  | { payer: "sponsor" }
  /** The agent pays from its own Fee Juice and is named as payer; `allowed` is the user's consent. */
  | { payer: "account"; allowed: boolean };

export function feeMode(ctx: Pick<ResolvedContext, "network" | "publicFees">): FeeMode {
  return ctx.network.sponsoredFees ? { payer: "sponsor" } : { payer: "account", allowed: ctx.publicFees };
}

/** Refuses, before anything moves, a tx that would name the agent as fee payer without the user's consent. */
export function assertFeeConsent(ctx: Pick<ResolvedContext, "network" | "publicFees">): void {
  const mode = feeMode(ctx);
  if (mode.payer === "sponsor" || mode.allowed) return;
  throw new UsageError(
    `Network "${ctx.network.name}" has no fee sponsor: the agent would pay fees from its own Fee Juice, which names ` +
      "its account publicly as the payer of each payment (amounts and merchants stay private), and its Fee Juice " +
      "deposit links that account to the Ethereum address it came from. Ask the user; to accept, run " +
      "`aztec-x402 config set publicFees true` (or set AZTEC_X402_PUBLIC_FEES=1).",
    "public_fees_not_allowed",
    { network: ctx.network.name },
  );
}

/** Refuses before proving when the agent must pay its own fee and holds no Fee Juice at all. */
export async function assertHoldsFeeJuice(
  ctx: Pick<ResolvedContext, "network">,
  node: AztecNode,
  account: AztecAddress,
): Promise<void> {
  if (ctx.network.sponsoredFees) return;
  if ((await getFeeJuiceBalance(account, node)) > 0n) return;
  throw new CliError(
    `The agent pays its own fees on "${ctx.network.name}" and ${account} holds no Fee Juice: run \`aztec-x402 fund\` first.`,
    "no_fee_juice",
    { network: ctx.network.name, address: account.toString() },
  );
}
