/**
 * AIP-20 standard token contract wrapper.
 *
 * Uses the unmodified AIP-20 token from @defi-wonderland/aztec-standards,
 * compiled against Aztec v4.1.0-nightly.20260314 for sandbox compatibility.
 *
 * Key methods for x402 commitment flow:
 * - `initialize_transfer_commitment(to, completer)` — creates partial note
 * - `transfer_private_to_commitment(from, commitment, amount, nonce)` — completes transfer
 */
import {
  loadContractArtifact,
  loadContractArtifactForPublic,
} from "@aztec/aztec.js/abi";
import { Contract, ContractBase, DeployMethod } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/aztec.js/fields";
import { PublicKeys } from "@aztec/aztec.js/keys";

import TokenContractArtifactJson from "../token/target/token_contract-Token.json" with {
  type: "json",
};

export const TokenContractArtifact = loadContractArtifact(
  TokenContractArtifactJson as any,
);

/**
 * Type-safe interface for the AIP-20 standard Token contract.
 */
export class TokenContract extends ContractBase {
  constructor(address: any, wallet: any) {
    super(address, TokenContractArtifact, wallet);
  }

  static at(address: any, wallet: any) {
    return Contract.at(address, TokenContract.artifact, wallet);
  }

  /**
   * Deploy with constructor_with_minter(name, symbol, decimals, minter).
   */
  static deploy(
    wallet: any,
    name: string,
    symbol: string,
    decimals: number,
    minter: any,
  ) {
    return new DeployMethod(
      PublicKeys.default(),
      wallet,
      TokenContractArtifact,
      (instance: any, wallet: any) => TokenContract.at(instance.address, wallet),
      Array.from(arguments).slice(1),
    );
  }

  static deployWithPublicKeys(
    publicKeys: any,
    wallet: any,
    name: string,
    symbol: string,
    decimals: number,
    minter: any,
  ) {
    return new DeployMethod(
      publicKeys,
      wallet,
      TokenContractArtifact,
      (instance: any, wallet: any) => TokenContract.at(instance.address, wallet),
      Array.from(arguments).slice(2),
    );
  }

  static get artifact() {
    return TokenContractArtifact;
  }

  static get artifactForPublic() {
    return loadContractArtifactForPublic(TokenContractArtifactJson as any);
  }

  /** AIP-20 storage layout (slots match struct field order in main.nr). */
  static get storage() {
    return {
      name: { slot: new Fr(1n) },
      symbol: { slot: new Fr(2n) },
      decimals: { slot: new Fr(3n) },
      private_balances: { slot: new Fr(4n) },
      total_supply: { slot: new Fr(5n) },
      public_balances: { slot: new Fr(6n) },
      minter: { slot: new Fr(7n) },
    };
  }
}
