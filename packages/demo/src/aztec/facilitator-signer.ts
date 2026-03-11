/**
 * Real FacilitatorAztecSigner — wraps an Aztec AccountWallet and TokenContract
 * to verify payments via PXE note discovery on the Aztec network.
 */
import type { FacilitatorAztecSigner } from "@aztech-x402/core";

interface TokenMethods {
  balance_of_private(owner: unknown): {
    simulate(opts?: { from?: unknown }): Promise<{ result: bigint }>;
  };
}

interface AztecPXE {
  registerSender(address: unknown): Promise<unknown>;
}

interface AztecWallet {
  getAddress(): { toString(): string };
}

export class RealFacilitatorAztecSigner implements FacilitatorAztecSigner {
  constructor(
    private readonly wallet: AztecWallet,
    private readonly token: { methods: TokenMethods },
    private readonly pxe: AztecPXE,
  ) {}

  async getAddresses(): Promise<string[]> {
    return [this.wallet.getAddress().toString()];
  }

  async registerSender(senderAddress: string): Promise<void> {
    // Register the sender so the PXE can discover notes tagged by them.
    // In the Aztec SDK, addresses are objects — but registerSender also
    // accepts raw address strings depending on the version.
    // We pass the string and let the PXE handle parsing.
    await this.pxe.registerSender(senderAddress);
  }

  async getPrivateBalance(
    _tokenAddress: string,
    ownerAddress: string,
  ): Promise<bigint> {
    // balance_of_private is an unconstrained function — we call .simulate()
    // with { from: owner } so the PXE decrypts the relevant notes.
    const balance = await this.token.methods
      .balance_of_private(ownerAddress)
      .simulate();

    return BigInt(balance);
  }
}
