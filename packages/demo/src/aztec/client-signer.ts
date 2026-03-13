/**
 * Real ClientAztecSigner — wraps an Aztec AccountManager and the
 * official Aztec Token contract to complete commitment-based private transfers.
 *
 * The server creates the commitment via prepare_private_balance_increase.
 * The client only calls finalize_transfer_to_private_from_private to fund it.
 */
import type { ClientAztecSigner } from "@aztec-x402/core";
import { AztecAddress } from "@aztec/aztec.js/addresses";

interface AztecAccount {
  address: AztecAddress;
}

interface TokenContract {
  methods: {
    finalize_transfer_to_private_from_private(
      from: AztecAddress,
      partial_note: { commitment: unknown },
      amount: bigint,
      authwit_nonce: unknown,
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

    // Complete the transfer using the server-provided commitment.
    // The server already called prepare_private_balance_increase(serverAddr),
    // so this commitment is bound to the server's address as recipient.
    const interaction =
      this.token.methods.finalize_transfer_to_private_from_private(from, { commitment }, amount, 0);
    await interaction.simulate({ from });

    const opts: Record<string, unknown> = { from, wait: { timeout: 120 } };
    if (this.sendOpts?.fee) {
      opts.fee = this.sendOpts.fee;
    }
    const receipt = await interaction.send(opts);
    return receipt.txHash.toString();
  }
}
