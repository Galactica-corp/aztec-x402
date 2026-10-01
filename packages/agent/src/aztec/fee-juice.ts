/**
 * Fee Juice: the protocol's gas token on Aztec, held as a public balance.
 */
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
import { unwrapAztecSdkResult } from "@galactica-net/x402-core";
import type { Session } from "./session.js";

export const FEE_JUICE_DECIMALS = 18;

export async function feeJuiceBalance(session: Pick<Session, "wallet" | "address">): Promise<bigint> {
  const feeJuice = FeeJuiceContract.at(session.wallet);
  const result = await feeJuice.methods.balance_of_public(session.address).simulate({ from: session.address });
  const value = unwrapAztecSdkResult(result);
  return typeof value === "bigint" ? value : BigInt(String(value));
}
