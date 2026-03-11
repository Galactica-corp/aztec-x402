/**
 * Real ClientAztecSigner — wraps an Aztec AccountManager and TokenContract
 * to execute private-to-private token transfers on the Aztec network.
 */
import type { ClientAztecSigner } from "@aztec-x402/core";
import { AztecAddress } from "@aztec/aztec.js/addresses";

interface AztecAccount {
  address: AztecAddress;
}

interface TokenContract {
  methods: {
    transfer(to: AztecAddress, amount: bigint): {
      simulate(opts: { from: AztecAddress }): Promise<unknown>;
      send(opts: Record<string, unknown>): Promise<{ txHash: { toString(): string } }>;
    };
  };
}

export class RealClientAztecSigner implements ClientAztecSigner {
  constructor(
    private readonly account: AztecAccount,
    private readonly token: TokenContract,
    private readonly sendOpts?: { fee?: unknown },
  ) {}

  async getAddress(): Promise<string> {
    return this.account.address.toString();
  }

  async transferPrivateToPrivate(
    _tokenAddress: string,
    to: string,
    amount: bigint,
  ): Promise<string> {
    const recipient = AztecAddress.fromString(to);
    const from = this.account.address;
    const method = this.token.methods.transfer(recipient, amount);
    await method.simulate({ from });
    const opts: Record<string, unknown> = { from, wait: { timeout: 120 } };
    if (this.sendOpts?.fee) {
      opts.fee = this.sendOpts.fee;
    }
    const receipt = await method.send(opts);
    return receipt.txHash.toString();
  }
}
