/**
 * Real ClientAztecSigner — wraps an Aztec AccountManager and TokenContract
 * to execute direct private token transfers on the Aztec network.
 */
import type { ClientAztecSigner } from "@aztec-x402/core";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";

interface AztecAccount {
  address: AztecAddress;
}

interface TokenContract {
  methods: {
    transfer_private_to_private(
      from: AztecAddress,
      to: AztecAddress,
      amount: bigint,
      nonce: Fr,
    ): {
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

  async finalizePayment(
    _tokenAddress: string,
    payTo: string,
    amount: bigint,
  ): Promise<string> {
    const from = this.account.address;
    const to = AztecAddress.fromString(payTo);
    const method = this.token.methods.transfer_private_to_private(
      from,
      to,
      amount,
      Fr.ZERO,
    );
    await method.simulate({ from });
    const opts: Record<string, unknown> = { from, wait: { timeout: 120 } };
    if (this.sendOpts?.fee) {
      opts.fee = this.sendOpts.fee;
    }
    const receipt = await method.send(opts);
    return receipt.txHash.toString();
  }
}
