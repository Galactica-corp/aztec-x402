/**
 * Real ClientAztecSigner — wraps an Aztec AccountManager and TokenContract
 * to finalize commitment-based private token transfers on the Aztec network.
 */
import type { ClientAztecSigner } from "@aztec-x402/core";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";

interface AztecAccount {
  address: AztecAddress;
}

interface TokenContract {
  methods: {
    finalize_transfer_to_private_from_private(
      from: AztecAddress,
      partial_note: { commitment: Fr },
      amount: bigint,
      authwit_nonce: Fr,
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
    commitment: string,
    amount: bigint,
  ): Promise<string> {
    const from = this.account.address;
    const commitmentField = Fr.fromString(commitment);
    const method = this.token.methods.finalize_transfer_to_private_from_private(
      from,
      { commitment: commitmentField },
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
