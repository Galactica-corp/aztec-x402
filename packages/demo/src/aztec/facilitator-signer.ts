/**
 * Real FacilitatorAztecSigner — wraps an Aztec AccountWallet and TokenContract
 * to verify payments via PXE note discovery on the Aztec network.
 */
import type { FacilitatorAztecSigner } from "@aztech-x402/core";
import { AztecAddress } from "@aztec/aztec.js";

interface TokenContract {
  methods: {
    balance_of_private(owner: AztecAddress): {
      simulate(): Promise<bigint>;
    };
  };
  withWallet(wallet: unknown): TokenContract;
}

interface AztecPXE {
  registerSender(address: AztecAddress): Promise<unknown>;
}

interface AztecWallet {
  getAddress(): AztecAddress;
}

export class RealFacilitatorAztecSigner implements FacilitatorAztecSigner {
  constructor(
    private readonly wallet: AztecWallet,
    private readonly token: TokenContract,
    private readonly pxe: AztecPXE,
  ) {}

  async getAddresses(): Promise<string[]> {
    return [this.wallet.getAddress().toString()];
  }

  async registerSender(senderAddress: string): Promise<void> {
    // Convert string address to AztecAddress object for the SDK
    const address = AztecAddress.fromString(senderAddress);
    await this.pxe.registerSender(address);
  }

  async getPrivateBalance(
    _tokenAddress: string,
    ownerAddress: string,
  ): Promise<bigint> {
    // balance_of_private is an unconstrained function.
    // .simulate() returns the bigint value directly (no { result } wrapper).
    // The token was instantiated with this wallet, so PXE has the right keys.
    const owner = AztecAddress.fromString(ownerAddress);
    const balance = await this.token.methods
      .balance_of_private(owner)
      .simulate();

    return BigInt(balance);
  }
}
