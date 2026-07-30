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
import { CallAuthorizationRequest } from "@aztec/aztec.js/authorization";
import { extractOffchainOutput, NO_WAIT } from "@aztec/aztec.js/contracts";
import type { OffchainMessage } from "@aztec/aztec.js/contracts";
// v5 moved getGasLimits out of aztec.js and changed its signature: it now takes
// the simulated gas usage plus the network's per-tx admission limit.
import { getGasLimits } from "@aztec/wallet-sdk/base-wallet";
import { waitForTx } from "@aztec/aztec.js/node";
import { EmbeddedWallet as NodeEmbeddedWallet, type EmbeddedWalletOptions } from "@aztec/wallets/embedded";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { ExecutionPayload } from "@aztec/aztec.js/tx";
import { TxSimulationResultWithAppOffset } from "@aztec/aztec.js/wallet";
import type { SendOptions } from "@aztec/aztec.js/wallet";
import { GasSettings } from "@aztec/stdlib/gas";
import { collectOffchainEffects } from "@aztec/stdlib/tx";
import { inspect } from "util";

interface SendTxWithAppReturnValuesResult {
  receipt?: { txHash?: { toString(): string }; debugLogs?: unknown[] };
  txHash?: { toString(): string };
  offchainEffects?: unknown[];
  offchainMessages?: OffchainMessage[];
  appReturnValues?: unknown[];
}

function debugSend(message: string) {
  if (process.env.AZTEC_X402_DEBUG === "true") {
    console.log(`[pxe-wallet] ${message}`);
  }
}

export class PXEWallet extends NodeEmbeddedWallet {
  /**
   * Sends a transaction and returns the app call values from the proven execution.
   *
   * ContractFunctionInteraction.simulate() and send() are separate executions. For
   * functions that use `unsafe { random() }`, such as partial-note commitment
   * preparation, the simulate return value can differ from the proven transaction
   * that is actually sent. This helper mirrors EmbeddedWallet.sendTx(), but exposes
   * the private app return values from the proven tx before submitting it.
   */
  async sendTxWithAppReturnValues(
    executionPayload: ExecutionPayload,
    opts: SendOptions<any>,
  ): Promise<SendTxWithAppReturnValuesResult> {
    const estimationFeeOptions = await this.completeFeeOptions({
      from: opts.from,
      feePayer: executionPayload.feePayer,
      gasSettings: opts.fee?.gasSettings,
      forEstimation: true,
    });

    const simulationResult = await this.simulateViaEntrypoint(executionPayload, {
      from: opts.from,
      feeOptions: estimationFeeOptions,
      additionalScopes: opts.additionalScopes,
      skipTxValidation: true,
      sendMessagesAs: opts.sendMessagesAs,
    });

    const offchainEffects = collectOffchainEffects(simulationResult.privateExecutionResult);
    const authWitnesses = await Promise.all(
      offchainEffects.map(async (effect) => {
        try {
          const authRequest = await CallAuthorizationRequest.fromFields(effect.data);
          return this.createAuthWit(authRequest.onBehalfOf, {
            consumer: effect.contractAddress,
            innerHash: authRequest.innerHash,
          });
        } catch {
          return undefined;
        }
      }),
    );
    for (const authwit of authWitnesses) {
      if (authwit) {
        executionPayload.authWitnesses.push(authwit);
      }
    }

    const maxTxGasLimits = await this.getMaxTxGasLimits();
    const estimated = getGasLimits(
      simulationResult.gasUsed,
      maxTxGasLimits,
      this.estimatedGasPadding,
    );
    const gasSettings = GasSettings.from({
      ...opts.fee?.gasSettings,
      maxFeesPerGas: estimationFeeOptions.gasSettings.maxFeesPerGas,
      maxPriorityFeesPerGas: estimationFeeOptions.gasSettings.maxPriorityFeesPerGas,
      gasLimits: opts.fee?.gasSettings?.gasLimits ?? estimated.gasLimits,
      teardownGasLimits:
        opts.fee?.gasSettings?.teardownGasLimits ?? estimated.teardownGasLimits,
    });

    const feeOptions = await this.completeFeeOptions({
      from: opts.from,
      feePayer: executionPayload.feePayer,
      gasSettings,
    });
    const txRequest = await this.createTxExecutionRequestFromPayloadAndFee(
      executionPayload,
      opts.from,
      feeOptions,
    );
    // v5 takes an options bag and needs `senderForTags` — without it any private
    // log this tx emits (including the partial-note completion log the payment
    // verification reads) trips the "Sender for tags is not set" assertion.
    const provenTx = await this.pxe.proveTx(txRequest, {
      scopes: this.scopesFrom(opts.from, opts.additionalScopes),
      senderForTags: this.senderForTagsFrom(opts.from, opts.sendMessagesAs),
    });
    debugSend("proved tx");
    const offchainOutput = extractOffchainOutput(
      provenTx.getOffchainEffects(),
      provenTx.publicInputs.constants.anchorBlockHeader.globalVariables.timestamp,
    );
    debugSend("extracted offchain output");
    const entrypointAppCallOffset = await this.computeAppCallOffset(opts.from, feeOptions);
    const appCallOffset =
      entrypointAppCallOffset === 0
        ? 0
        : entrypointAppCallOffset + Math.max(0, executionPayload.calls.length - 1);
    debugSend(`computed app call offset ${appCallOffset}`);
    const provenResult = new TxSimulationResultWithAppOffset(
      provenTx.privateExecutionResult,
      provenTx.publicInputs,
      undefined,
      undefined,
      appCallOffset,
    );
    const appReturnValues =
      provenResult.getPrivateReturnValuesOfAppCall(0)?.values ?? [];
    debugSend(`extracted ${appReturnValues.length} app return values`);

    debugSend("building tx");
    const tx = await provenTx.toTx();
    const txHash = tx.getTxHash();
    debugSend(`built tx ${txHash.toString()}`);
    debugSend("checking duplicate tx effect");
    // v5: getTxEffect is deprecated; a mined receipt is the settled-tx signal.
    if ((await this.aztecNode.getTxReceipt(txHash)).isMined()) {
      throw new Error(`A settled tx with equal hash ${txHash.toString()} exists.`);
    }

    debugSend("sending tx");
    await this.aztecNode.sendTx(tx).catch((err: Error) => {
      throw this.contextualizeError(err, inspect(tx));
    });
    debugSend(`sent tx ${txHash.toString()}`);

    if (opts.wait === NO_WAIT) {
      return { txHash, appReturnValues, ...offchainOutput };
    }

    const waitOpts = typeof opts.wait === "object" ? opts.wait : undefined;
    debugSend("waiting for tx");
    const receipt = await waitForTx(this.aztecNode, txHash, waitOpts);
    debugSend(`tx reached ${receipt.status}`);
    return { receipt, appReturnValues, ...offchainOutput };
  }

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
    const [executionPayload, opts] = args;
    const txRequest = await this.createTxExecutionRequestFromPayloadAndFee(
      executionPayload,
      opts.from,
      opts.feeOptions,
    );
    const result = await this.pxe.simulateTx(txRequest, {
      simulatePublic: true,
      skipTxValidation: opts.skipTxValidation,
      skipFeeEnforcement: opts.skipFeeEnforcement,
      scopes: this.scopesFrom(opts.from, opts.additionalScopes),
      senderForTags: this.senderForTagsFrom(opts.from, opts.sendMessagesAs),
    });
    const appCallOffset = await this.computeAppCallOffset(opts.from, opts.feeOptions);
    return TxSimulationResultWithAppOffset.fromResultAndOffset(result, appCallOffset);
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
