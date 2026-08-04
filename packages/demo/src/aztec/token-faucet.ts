/**
 * Helpers for deploying a Dripper faucet and minting private tokens through it.
 *
 * The Dripper must be the token's configured minter (`constructor_with_minter`).
 * Callers then invoke `drip_to_private(token, amount)` to mint into their own
 * private balance — Alice does not need to be the minter.
 */
import { AztecAddress } from "@aztec/aztec.js/addresses";

/** Args for Token `constructor_with_minter` when the Dripper is the minter. */
export function tokenConstructorWithDripperArgs(
  name: string,
  symbol: string,
  decimals: number,
  dripper: AztecAddress,
): readonly [string, string, number, AztecAddress, AztecAddress] {
  // auth_contract: optional Wonderland authorization hook. Zero disables it.
  return [name, symbol, decimals, dripper, AztecAddress.ZERO] as const;
}

export type DripInteraction = {
  simulate: (opts: { from: AztecAddress }) => Promise<unknown>;
  send: (opts: unknown) => Promise<unknown>;
};

export type DripperLike = {
  methods: {
    drip_to_private: (
      tokenAddress: AztecAddress,
      amount: bigint,
    ) => DripInteraction;
  };
};

/**
 * Mint `amount` into `from`'s private balance via the Dripper faucet.
 * The Dripper must already be the token's minter.
 */
export async function dripToPrivate(
  dripper: DripperLike,
  tokenAddress: AztecAddress,
  amount: bigint,
  from: AztecAddress,
  sendOpts: unknown,
): Promise<void> {
  await dripper.methods
    .drip_to_private(tokenAddress, amount)
    .simulate({ from });
  await dripper.methods
    .drip_to_private(tokenAddress, amount)
    .send(sendOpts);
}
