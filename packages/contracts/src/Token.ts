/**
 * Forked TokenContract wrapper for the x402 custom token contract.
 *
 * This is a minimal fork of the official Aztec v4.0.4 TokenContract with one change:
 * `prepare_private_balance_increase(to, completer)` accepts an explicit completer
 * parameter, enabling cross-party commitment flows where the server prepares and
 * the client finalizes.
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
 * Type-safe interface for the forked Token contract with cross-party commitment support.
 */
export class TokenContract extends ContractBase {
  constructor(address: any, wallet: any) {
    super(address, TokenContractArtifact, wallet);
  }

  static at(address: any, wallet: any) {
    return Contract.at(address, TokenContract.artifact, wallet);
  }

  static deploy(
    wallet: any,
    admin: any,
    name: string,
    symbol: string,
    decimals: number,
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
    admin: any,
    name: string,
    symbol: string,
    decimals: number,
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

  static get storage() {
    return {
      admin: { slot: new Fr(1n) },
      minters: { slot: new Fr(2n) },
      balances: { slot: new Fr(3n) },
      total_supply: { slot: new Fr(4n) },
      public_balances: { slot: new Fr(5n) },
      symbol: { slot: new Fr(6n) },
      name: { slot: new Fr(8n) },
      decimals: { slot: new Fr(10n) },
    };
  }
}
