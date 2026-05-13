/**
 * AIP-20 standard token contract wrapper.
 *
 * The demo uses Wonderland's published Aztec Standards artifact for v4.2.x.
 * This local wrapper preserves the existing `@aztec-x402/contracts/Token`
 * import surface and defaults deployment to `constructor_with_minter`.
 */
import {
  TokenContract as WonderlandTokenContract,
  TokenContractArtifact,
} from "@defi-wonderland/aztec-standards/dist/src/artifacts/Token.js";

export { TokenContractArtifact };

export class TokenContract {
  static at = WonderlandTokenContract.at;
  static deployWithPublicKeys = WonderlandTokenContract.deployWithPublicKeys;
  static deployWithOpts = WonderlandTokenContract.deployWithOpts;

  static deploy(
    wallet: Parameters<typeof WonderlandTokenContract.deploy>[0],
    name: string,
    symbol: string,
    decimals: bigint | number,
    minter: unknown,
  ) {
    return WonderlandTokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      name,
      symbol,
      decimals,
      minter,
    );
  }

  static get artifact() {
    return WonderlandTokenContract.artifact;
  }

  static get artifactForPublic() {
    return WonderlandTokenContract.artifactForPublic;
  }

  static get storage() {
    return WonderlandTokenContract.storage;
  }

  static get events() {
    return WonderlandTokenContract.events;
  }
}
