/**
 * Fee Juice portal adapter: the user bridges the rollup's L1 fee asset to the
 * agent's Aztec account as Fee Juice (Aztec gas).
 *
 * On testnet the L1 fee asset has a public faucet (FeeAssetHandler.mint), so
 * the user only needs Sepolia ETH for gas. Fee Juice deposits are public by
 * protocol design (`depositToAztecPublic`): the amount and recipient are
 * visible on L1. Payments the agent makes afterwards stay private.
 */
import {
  createPublicClient,
  encodeFunctionData,
  getAbiItem,
  http,
  parseEventLogs,
  type PublicClient,
} from "viem";
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
import { FEE_JUICE_DECIMALS, feeJuiceBalance } from "../aztec/fee-juice.js";
import { CliError } from "../errors.js";
import type { DepositRecord } from "./deposits.js";
import {
  OWNER_WORD,
  toHex,
  type BridgeAdapter,
  type BridgeDescription,
  type Hex,
  type L1Deposit,
  type PlanStep,
} from "./bridge.js";
import { trimAmount } from "../x402.js";

/** Fee Juice the agent asks for by default: plenty for hundreds of transactions. */
const DEFAULT_AMOUNT = "100";
/** Most public RPCs cap eth_getLogs ranges; search in chunks of this many blocks. */
const LOG_CHUNK_BLOCKS = 10_000n;

/** Encoded in place of the user's address, then swapped for OWNER_WORD. */
const OWNER_SENTINEL: Hex = `0x${"ee".repeat(20)}`;
const OWNER_SENTINEL_WORD = "0".repeat(24) + "ee".repeat(20);

function withOwner(data: Hex): string {
  if (!data.includes(OWNER_SENTINEL_WORD)) throw new Error("calldata has no owner placeholder");
  return data.replace(OWNER_SENTINEL_WORD, OWNER_WORD);
}

export interface L1Addresses {
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
    return FeeJuiceBridge.fromAddresses(network.l1RpcUrl, {
      portal: toHex(portal),
      token: toHex(token),
      handler: handler && !isZero(handler) ? toHex(handler) : undefined,
    });
  }

  /** For known L1 addresses, without asking the Aztec node. */
  static fromAddresses(l1RpcUrl: string, addresses: L1Addresses): FeeJuiceBridge {
    return new FeeJuiceBridge(createPublicClient({ transport: http(l1RpcUrl) }), addresses);
  }

  async describe(): Promise<BridgeDescription> {
    return {
      id: "fee-juice",
      title: "Fee Juice (Aztec gas)",
      result: "Fee Juice in the agent's Aztec account: gas for its own transactions.",
      l1Token: { symbol: "FEE", decimals: FEE_JUICE_DECIMALS, address: this.addresses.token },
      portal: this.addresses.portal,
      defaultAmount: DEFAULT_AMOUNT,
      privacy:
        "Fee Juice deposits are public on L1 (amount and Aztec recipient are visible). The agent's payments stay private.",
    };
  }

  parseAmount(amount: string): bigint {
    return parsePrice(amount, FEE_JUICE_DECIMALS);
  }

  formatAmount(amount: bigint): string {
    return trimAmount(formatAmount(amount, FEE_JUICE_DECIMALS));
  }

  steps(deposit: DepositRecord): PlanStep[] {
    const amount = BigInt(deposit.amount);
    const { token, portal, handler } = this.addresses;
    const hasEnough = {
      to: token,
      data: withOwner(encodeFunctionData({ abi: TestERC20Abi, functionName: "balanceOf", args: [OWNER_SENTINEL] })),
      gte: amount.toString(),
    };
    const steps: PlanStep[] = [];
    if (handler) {
      steps.push({
        id: "mint",
        label: "Get test FEE from the public testnet faucet",
        to: handler,
        data: withOwner(encodeFunctionData({ abi: FeeAssetHandlerAbi, functionName: "mint", args: [OWNER_SENTINEL] })),
        skipIf: hasEnough,
        repeat: true,
      });
    }
    steps.push({
      id: "approve",
      label: `Allow the Fee Juice portal to take ${this.formatAmount(amount)} FEE`,
      to: token,
      data: encodeFunctionData({ abi: TestERC20Abi, functionName: "approve", args: [portal, amount] }),
      skipIf: {
        to: token,
        data: withOwner(
          encodeFunctionData({ abi: TestERC20Abi, functionName: "allowance", args: [OWNER_SENTINEL, portal] }),
        ),
        gte: amount.toString(),
      },
    });
    steps.push({
      id: "deposit",
      label: `Deposit ${this.formatAmount(amount)} FEE to the agent on Aztec`,
      to: portal,
      data: encodeFunctionData({
        abi: FeeJuicePortalAbi,
        functionName: "depositToAztecPublic",
        args: [toHex(deposit.recipient), amount, toHex(deposit.secretHash)],
      }),
    });
    return steps;
  }

  l1BlockNumber(): Promise<bigint> {
    return this.l1.getBlockNumber();
  }

  async findDeposit(deposit: DepositRecord, fromBlock: bigint): Promise<Hex | undefined> {
    const event = getAbiItem({ abi: FeeJuicePortalAbi, name: "DepositToAztecPublic" });
    const latest = await this.l1.getBlockNumber();
    for (let start = fromBlock; start <= latest; start += LOG_CHUNK_BLOCKS) {
      const end = start + LOG_CHUNK_BLOCKS - 1n < latest ? start + LOG_CHUNK_BLOCKS - 1n : latest;
      const logs = await this.l1.getLogs({
        address: this.addresses.portal,
        event,
        args: { to: toHex(deposit.recipient) },
        fromBlock: start,
        toBlock: end,
      });
      const match = logs.find((l) => l.args.secretHash?.toLowerCase() === deposit.secretHash.toLowerCase());
      if (match) return match.transactionHash;
    }
    return undefined;
  }

  async readDeposit(l1TxHash: Hex, timeoutMs = 180_000): Promise<L1Deposit> {
    const receipt = await this.l1.waitForTransactionReceipt({ hash: l1TxHash, timeout: timeoutMs });
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

  l2Balance(session: Session): Promise<bigint> {
    return feeJuiceBalance(session);
  }
}
