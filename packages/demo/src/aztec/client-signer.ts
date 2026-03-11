/**
 * Real ClientAztecSigner — wraps an Aztec AccountWallet and TokenContract
 * to execute private-to-private token transfers on the Aztec network.
 */
import type { ClientAztecSigner } from "@aztech-x402/core";
import { AztecAddress } from "@aztec/aztec.js";

interface AztecWallet {
  getAddress(): AztecAddress;
}

interface TokenContract {
  methods: {
    transfer(to: AztecAddress, amount: bigint): {
      send(): { wait(): Promise<{ txHash: { toString(): string } }> };
    };
  };
}

export class RealClientAztecSigner implements ClientAztecSigner {
  constructor(
    private readonly wallet: AztecWallet,
    private readonly token: TokenContract,
  ) {}

  async getAddress(): Promise<string> {
    return this.wallet.getAddress().toString();
  }

  async transferPrivateToPrivate(
    _tokenAddress: string,
    to: string,
    amount: bigint,
  ): Promise<string> {
    // Convert string address to AztecAddress for the SDK.
    // token.methods.transfer(to, amount) does private-to-private
    // where sender = msg_sender (this wallet).
    const recipient = AztecAddress.fromString(to);
    const receipt = await this.token.methods
      .transfer(recipient, amount)
      .send()
      .wait();

    return receipt.txHash.toString();
  }
}
