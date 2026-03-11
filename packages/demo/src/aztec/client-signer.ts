/**
 * Real ClientAztecSigner — wraps an Aztec AccountWallet and TokenContract
 * to execute private-to-private token transfers on the Aztec network.
 */
import type { ClientAztecSigner } from "@aztech-x402/core";

interface TokenMethods {
  transfer(to: unknown, amount: bigint): {
    send(opts?: { from?: unknown }): { wait(): Promise<unknown> };
  };
}

interface AztecWallet {
  getAddress(): unknown;
}

export class RealClientAztecSigner implements ClientAztecSigner {
  constructor(
    private readonly wallet: AztecWallet,
    private readonly token: { methods: TokenMethods },
  ) {}

  async getAddress(): Promise<string> {
    return this.wallet.getAddress().toString();
  }

  async transferPrivateToPrivate(
    _tokenAddress: string,
    to: string,
    amount: bigint,
  ): Promise<string> {
    // token.methods.transfer(to, amount) does private-to-private
    // where sender = msg_sender (this wallet)
    const receipt = await this.token.methods
      .transfer(to, amount)
      .send({ from: this.wallet.getAddress() })
      .wait();

    // Return the tx hash for record-keeping
    return String((receipt as Record<string, unknown>).txHash ?? "0x0");
  }
}
