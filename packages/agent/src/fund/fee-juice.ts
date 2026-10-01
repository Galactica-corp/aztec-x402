/**
 * Fee Juice portal adapter: the user bridges the rollup's L1 fee asset to the
 * agent's Aztec account, so the agent can pay its own transaction fees.
 *
 * On testnet the L1 fee asset has a public faucet (FeeAssetHandler.mint), so
 * the user only needs Sepolia ETH for gas. Fee Juice deposits are public by
 * protocol design (`depositToAztecPublic`): the amount and recipient are
 * visible on L1. Payments the agent makes afterwards stay private.
 */
import { createPublicClient, encodeFunctionData, http, parseEventLogs, type PublicClient } from "viem";
import { FeeAssetHandlerAbi } from "@aztec/l1-artifacts/FeeAssetHandlerAbi";
import { FeeJuicePortalAbi } from "@aztec/l1-artifacts/FeeJuicePortalAbi";
import { TestERC20Abi } from "@aztec/l1-artifacts/TestERC20Abi";
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { formatAmount, parsePrice } from "@galactica-net/x402-core";
import type { NetworkConfig } from "../networks.js";
import type { Session } from "../aztec/session.js";
import { CliError } from "../errors.js";
import type { DepositRecord } from "./deposits.js";
import { toHex as asHex, type BridgeAdapter, type BridgeDescription, type Hex, type L1Deposit, type PreparedL1Tx } from "./bridge.js";
import { trimAmount } from "../x402.js";

const DECIMALS = 18;
/** Fee Juice the agent asks for by default: plenty for hundreds of payments. */
const DEFAULT_AMOUNT = "100";

interface L1Addresses {
  portal: Hex;
  token: Hex;
  handler?: Hex;
}

function isZero(address: string): boolean {
  return /^0x0*$/.test(address);
}

export class FeeJuiceBridge implements BridgeAdapter {
  private constructor(
    private readonly l1: PublicClient,
    private readonly addresses: L1Addresses,
  ) {}

  static async create(network: NetworkConfig): Promise<FeeJuiceBridge> {
    const node = createAztecNodeClient(network.nodeUrl);
    const { l1ChainId, l1ContractAddresses } = await node.getNodeInfo();
    if (l1ChainId !== network.l1ChainId) {
      throw new CliError(`Node reports L1 chain ${l1ChainId}, expected ${network.l1ChainId}`, "l1_mismatch");
    }
    const portal = l1ContractAddresses.feeJuicePortalAddress.toString();
    const token = l1ContractAddresses.feeJuiceAddress.toString();
    if (isZero(portal) || isZero(token)) {
      throw new CliError("This network has no Fee Juice portal on L1", "no_bridge");
    }
    const handler = l1ContractAddresses.feeAssetHandlerAddress?.toString();
    const l1 = createPublicClient({ transport: http(network.l1RpcUrl) });
    return new FeeJuiceBridge(l1, {
      portal: asHex(portal),
      token: asHex(token),
      handler: handler && !isZero(handler) ? asHex(handler) : undefined,
    });
  }

  async describe(): Promise<BridgeDescription> {
    return {
      id: "fee-juice",
      title: "Fee Juice (Aztec gas)",
      result: "Fee Juice in the agent's Aztec account, used to pay its own transaction fees.",
      l1Token: { symbol: "FEE", decimals: DECIMALS, address: this.addresses.token },
      portal: this.addresses.portal,
      defaultAmount: DEFAULT_AMOUNT,
      privacy:
        "Fee Juice deposits are public on L1 (amount and Aztec recipient are visible). The agent's payments stay private.",
    };
  }

  parseAmount(amount: string): bigint {
    return parsePrice(amount, DECIMALS);
  }

  formatAmount(amount: bigint): string {
    return trimAmount(formatAmount(amount, DECIMALS));
  }

  async prepare(owner: Hex, deposit: DepositRecord): Promise<PreparedL1Tx[]> {
    const amount = BigInt(deposit.amount);
    const [balance, allowance] = await Promise.all([
      this.l1.readContract({ address: this.addresses.token, abi: TestERC20Abi, functionName: "balanceOf", args: [owner] }),
      this.l1.readContract({
        address: this.addresses.token,
        abi: TestERC20Abi,
        functionName: "allowance",
        args: [owner, this.addresses.portal],
      }),
    ]);

    const txs: PreparedL1Tx[] = [];
    if (balance < amount) {
      if (!this.addresses.handler) {
        throw new CliError(
          `L1 account holds ${this.formatAmount(balance)} FEE, needs ${this.formatAmount(amount)}`,
          "insufficient_l1_balance",
        );
      }
      const mintAmount = await this.l1.readContract({
        address: this.addresses.handler,
        abi: FeeAssetHandlerAbi,
        functionName: "mintAmount",
      });
      // The faucet mints a fixed amount per call; ask for as many as needed.
      const mints = Number((amount - balance + mintAmount - 1n) / mintAmount);
      for (let i = 0; i < mints; i++) {
        txs.push({
          id: `mint-${i + 1}`,
          label: `Get ${this.formatAmount(mintAmount)} test FEE from the public testnet faucet`,
          to: this.addresses.handler,
          data: encodeFunctionData({ abi: FeeAssetHandlerAbi, functionName: "mint", args: [owner] }),
        });
      }
    }
    if (allowance < amount) {
      txs.push({
        id: "approve",
        label: `Allow the Fee Juice portal to take ${this.formatAmount(amount)} FEE`,
        to: this.addresses.token,
        data: encodeFunctionData({
          abi: TestERC20Abi,
          functionName: "approve",
          args: [this.addresses.portal, amount],
        }),
      });
    }
    txs.push({
      id: "deposit",
      label: `Deposit ${this.formatAmount(amount)} FEE to the agent on Aztec`,
      to: this.addresses.portal,
      data: encodeFunctionData({
        abi: FeeJuicePortalAbi,
        functionName: "depositToAztecPublic",
        args: [asHex(deposit.recipient), amount, asHex(deposit.secretHash)],
      }),
    });
    return txs;
  }

  async readDeposit(l1TxHash: Hex): Promise<L1Deposit> {
    const receipt = await this.l1.waitForTransactionReceipt({ hash: l1TxHash, timeout: 180_000 });
    if (receipt.status !== "success") {
      throw new CliError(`L1 deposit ${l1TxHash} reverted`, "l1_reverted");
    }
    const [event] = parseEventLogs({
      abi: FeeJuicePortalAbi,
      logs: receipt.logs.filter((l) => l.address.toLowerCase() === this.addresses.portal.toLowerCase()),
      eventName: "DepositToAztecPublic",
    });
    if (!event) throw new CliError(`No Fee Juice deposit event in ${l1TxHash}`, "no_deposit_event");
    return {
      messageHash: event.args.key,
      leafIndex: event.args.index,
      amount: event.args.amount,
      recipient: event.args.to,
      secretHash: event.args.secretHash,
    };
  }

  async claim(session: Session, deposit: DepositRecord): Promise<string> {
    if (deposit.leafIndex === undefined) throw new Error("Deposit has no L1→L2 message index yet");
    const feeJuice = FeeJuiceContract.at(session.wallet);
    const result = await feeJuice.methods
      .claim(
        AztecAddress.fromStringUnsafe(deposit.recipient),
        BigInt(deposit.amount),
        Fr.fromString(deposit.secret),
        new Fr(BigInt(deposit.leafIndex)),
      )
      .send(session.sendOpts);
    return result.receipt.txHash.toString();
  }

  async l2Balance(session: Session): Promise<bigint> {
    const feeJuice = FeeJuiceContract.at(session.wallet);
    const result = await feeJuice.methods.balance_of_public(session.address).simulate({ from: session.address });
    const value = typeof result === "object" && result !== null && "result" in result ? result.result : result;
    return BigInt(String(value));
  }
}
