import { unwrapAztecSdkResult } from "@galactica-net/x402-core";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { DripperContract } from "@aztec-foundation/aztec-standards/dist/src/artifacts/Dripper.js";
import { openSession, tokenAt, type Session } from "../aztec/session.js";
import { FEE_JUICE_DECIMALS, feeJuiceBalance } from "../aztec/fee-juice.js";
import { formatAmount } from "@galactica-net/x402-core";
import { trimAmount } from "../x402.js";
import { findToken, type ResolvedContext } from "../config.js";
import { UsageError } from "../errors.js";
import type { TokenInfo } from "../networks.js";
import { parseAmount } from "../policy.js";
import { formatTokenAmount } from "../x402.js";
import { progress } from "../output.js";

function toBigInt(result: unknown): bigint {
  const value = unwrapAztecSdkResult(result);
  return typeof value === "bigint" ? value : BigInt(String(value));
}

function resolveTokens(ctx: ResolvedContext, token?: string): TokenInfo[] {
  if (!token) return ctx.network.tokens;
  const found = findToken(ctx.network, token);
  if (!found) {
    throw new UsageError(
      `Unknown token "${token}" on ${ctx.network.name}. Known: ${ctx.network.tokens.map((t) => t.symbol).join(", ") || "none"}`,
      "unknown_token",
    );
  }
  return [found];
}

export async function privateBalance(session: Session, token: TokenInfo): Promise<bigint> {
  const contract = await tokenAt(session, token.address);
  return toBigInt(await contract.methods.balance_of_private(session.address).simulate({ from: session.address }));
}

export async function balance(ctx: ResolvedContext, opts: { token?: string }) {
  const tokens = resolveTokens(ctx, opts.token);
  progress("Syncing private state...");
  const session = await openSession(ctx.network, ctx.dataDir);
  const balances = [];
  for (const token of tokens) {
    const amount = await privateBalance(session, token);
    balances.push({
      token: token.symbol,
      address: token.address,
      private: formatTokenAmount(amount, token),
      privateBaseUnits: amount.toString(),
    });
  }
  // Fee Juice is what `fund` deposits on testnet; show it so deposits can be confirmed.
  const gas = await feeJuiceBalance(session);
  return {
    network: ctx.network.name,
    account: session.address.toString(),
    balances,
    feeJuice: {
      token: "FEE",
      description: "Aztec gas (public balance)",
      public: trimAmount(formatAmount(gas, FEE_JUICE_DECIMALS)),
      publicBaseUnits: gas.toString(),
    },
  };
}

/** Mint testnet tokens into the agent's private balance via the token's Dripper. */
export async function faucet(ctx: ResolvedContext, opts: { token?: string; amount?: string }) {
  const [token] = resolveTokens(ctx, opts.token ?? ctx.network.tokens.find((t) => t.dripper)?.symbol);
  if (!token?.dripper) {
    throw new UsageError(`No faucet for ${token?.symbol ?? "any token"} on ${ctx.network.name}.`, "no_faucet");
  }
  const amountText = opts.amount ?? token.faucetAmount ?? "1";
  const amount = parseAmount(amountText, token, "--amount");

  progress("Syncing private state...");
  const session = await openSession(ctx.network, ctx.dataDir);
  const dripperAddress = AztecAddress.fromStringUnsafe(token.dripper);
  const instance = await session.node.getContract(dripperAddress);
  if (!instance) throw new UsageError(`Faucet contract ${token.dripper} is not deployed.`, "no_faucet");
  await session.wallet.registerContract(instance, DripperContract.artifact);
  const dripper = await DripperContract.at(dripperAddress, session.wallet);
  // The drip calls into the token, so the PXE must know its artifact too.
  await tokenAt(session, token.address);

  progress(`Proving faucet drip of ${amountText} ${token.symbol} (takes ~30-90s)...`);
  const result = await dripper.methods
    .drip_to_private(AztecAddress.fromStringUnsafe(token.address), amount)
    .send(session.sendOpts);
  const after = await privateBalance(session, token);
  return {
    network: ctx.network.name,
    account: session.address.toString(),
    token: token.symbol,
    minted: amountText,
    txHash: result.receipt.txHash.toString(),
    private: formatTokenAmount(after, token),
  };
}
