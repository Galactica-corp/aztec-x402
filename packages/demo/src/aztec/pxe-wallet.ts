/**
 * PXE Wallet — wraps EmbeddedWallet but uses real account entrypoints for simulation.
 *
 * ## Why not EmbeddedWallet directly?
 *
 * EmbeddedWallet overrides `simulateViaEntrypoint` to use STUB account contracts.
 * This causes two problems in the commitment-based payment flow:
 *
 * 1. **Account entrypoint mismatch**: `simulate()` runs through a stub account,
 *    while `send()` internally re-simulates through the real account. This produces
 *    different execution contexts (and potentially different randomness from
 *    `unsafe { random() }`), causing the commitment returned by `simulate()` to
 *    not match what goes on-chain.
 *
 * 2. **PXE sync bugs**: Several upstream issues affect EmbeddedWallet's PXE sync
 *    timing during multi-step commitment flows:
 *    - PR #15642: PXE::getNotes didn't trigger private state sync
 *    - PR #10613: PXE synchronizer updated state headers during simulation
 *    - Issue #15753: Account contracts broken with embedded PXE (Azguard Wallet)
 *
 * ## Solution
 *
 * This wallet uses the same full PXE (via `createPXE`) as EmbeddedWallet, but
 * restores the `BaseWallet.simulateViaEntrypoint` behavior: simulation runs through
 * the REAL account entrypoint, matching what `send()` does internally.
 *
 * This is equivalent to what Aztec's own `TestWallet` does in their e2e tests
 * (see yarn-project/end-to-end/src/test-wallet/test_wallet.ts).
 *
 * ## v4.1.0: simulate/send mismatch resolved
 *
 * On v4.1.0+, `send()` returns `{ receipt, offchainMessages }` where
 * offchainMessages are extracted from the **proven tx**. The commitment
 * now comes from the same execution that went on-chain, fixing the
 * simulate/send randomness mismatch.
 *
 * PXEWallet is still useful for ensuring consistent simulation behavior
 * (real account entrypoint instead of stubs), but the commitment extraction
 * no longer depends on simulate() matching send().
 *
 * @see https://github.com/AztecProtocol/aztec-packages/pull/15642
 * @see https://github.com/AztecProtocol/aztec-packages/pull/10613
 * @see https://github.com/AztecProtocol/aztec-packages/issues/15753
 */
import { EmbeddedWallet as NodeEmbeddedWallet, type EmbeddedWalletOptions } from "@aztec/wallets/embedded";
import type { AztecNode } from "@aztec/aztec.js/node";

export class PXEWallet extends NodeEmbeddedWallet {
  /**
   * Override: use the real account entrypoint for simulation instead of stubs.
   *
   * BaseWallet.simulateViaEntrypoint creates a proper TxExecutionRequest from the
   * real account contract and sends it through pxe.simulateTx. This ensures that
   * simulate() and send() see the same execution context, producing consistent
   * randomness and commitment values.
   *
   * EmbeddedWallet overrides this to use stub accounts (for faster, kernelless
   * simulation), which breaks the commitment pattern.
   */
  protected override async simulateViaEntrypoint(
    ...args: Parameters<NodeEmbeddedWallet["simulateViaEntrypoint"]>
  ) {
    // Replicate BaseWallet.simulateViaEntrypoint (two levels up), skipping
    // EmbeddedWallet's stub override. Uses the real account entrypoint.
    const [executionPayload, from, feeOptions, scopes, skipTxValidation, skipFeeEnforcement] = args;
    const txRequest = await this.createTxExecutionRequestFromPayloadAndFee(executionPayload, from, feeOptions);
    return this.pxe.simulateTx(txRequest, { simulatePublic: true, skipTxValidation, skipFeeEnforcement, scopes });
  }
}

/**
 * Create a PXEWallet connected to an Aztec node.
 *
 * Usage:
 * ```ts
 * const wallet = await createPXEWallet(node, { ephemeral: true });
 * ```
 */
export async function createPXEWallet(
  nodeOrUrl: string | AztecNode,
  options: EmbeddedWalletOptions = {},
): Promise<PXEWallet> {
  return PXEWallet.create(nodeOrUrl, options);
}
