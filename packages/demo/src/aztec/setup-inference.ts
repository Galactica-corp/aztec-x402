/**
 * Local-network setup for the inference-money USDC (`TOKEN=inference`).
 *
 * The token cannot be minted: it only arrives over inference-money's bridge
 * from L1, and a user can only pay a listed merchant. So on a local network
 * this deploys an instance of the whole bridge, with a mock L1 USDC, lists the
 * server as a merchant and funds the payer with a private deposit.
 *
 * On testnet none of this applies: the deployment is the one the SDK ships
 * (`TESTNET_MANIFEST`), its merchant list belongs to its admin, and funds come
 * from Sepolia USDC.
 *
 * Resumable: the deployment's manifest is kept next to deploy.json and reused
 * while its token exists on the node.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr } from "@aztec-labs/aztec.js/fields";
import type { AztecNode } from "@aztec-labs/aztec.js/node";
import {
  claim,
  confirmDeposit,
  ensurePermit2Allowance,
  l2UsdcBalance,
  merchantStatus,
  parseManifest,
  prepareDeposit,
  registerBridgeContracts,
  registerSponsor,
  signingKeyFor,
  submitDeposit,
  syncMerchantList,
  waitClaimable,
  type BridgeManifest,
} from "@galactica-net/inference-money-core";
import {
  addMerchants,
  BRIDGE_EVM_ARTIFACTS,
  deployTestBridge,
  installCanonicalPermit2,
  l1Signer,
  startBlockHeartbeat,
  writeEvm,
  type L1Signer,
} from "@galactica-net/inference-money-core/deploy";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { erc20Abi, maxUint256 } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { createPXEWallet, type PXEWallet } from "./pxe-wallet.js";

/** Anvil's public test mnemonic: the local network's own keys, not a credential. */
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
/** Not index 0: that is the local node's block publisher, and sharing it would race its nonces. */
const ANVIL_ACCOUNT_INDEX = 9;
/** A fixed local-only secret (like anvil's keys): its account deploys the bridge and stays merchant admin. */
const LOCAL_ADMIN_SECRET = new Fr(0x402_1ce_c0ffeen);

export interface InferenceSetup {
  node: AztecNode;
  nodeUrl: string;
  l1RpcUrl: string;
  wallet: PXEWallet;
  /** The server: listed as a merchant. */
  merchant: AztecAddress;
  /** The payer: funded with `amount` over the bridge. */
  payer: AztecAddress;
  amount: bigint;
  manifestPath: string;
  log: (message: string) => void;
}

async function loadOrDeploy(s: InferenceSetup, l1: L1Signer): Promise<{ manifest: BridgeManifest; admin: AztecAddress }> {
  if (existsSync(s.manifestPath)) {
    const manifest = parseManifest(JSON.parse(readFileSync(s.manifestPath, "utf-8")));
    if (await s.node.getContract(AztecAddress.fromStringUnsafe(manifest.l2.token.address))) {
      s.log(`Bridge already deployed (token ${manifest.l2.token.address}) — skipping.`);
      const admin = await s.wallet.createSchnorrAccount(LOCAL_ADMIN_SECRET, Fr.ZERO, signingKeyFor(LOCAL_ADMIN_SECRET));
      return { manifest, admin: admin.address };
    }
    s.log("Recorded bridge not found on this node — redeploying.");
  }
  s.log("Deploying the inference-money bridge (Permit2, mock USDC, portal, router, token, bridge)...");
  const { manifest, admin } = await deployTestBridge({
    network: "local",
    node: s.node,
    nodeUrl: s.nodeUrl,
    wallet: s.wallet,
    l1,
    deployerSecret: LOCAL_ADMIN_SECRET,
    usdc: "mock",
    permit2: await installCanonicalPermit2(l1),
    log: (m) => s.log(`  ${m}`),
  });
  writeFileSync(s.manifestPath, JSON.stringify(manifest, null, 2));
  return { manifest, admin };
}

/** Mints mock USDC on L1, deposits it privately for the payer and claims it on Aztec. */
async function fundPayer(s: InferenceSetup, l1: L1Signer, m: BridgeManifest): Promise<void> {
  const depositor = l1.account.address;
  await writeEvm(l1, "MockUsdc mint", m.l1.usdc, BRIDGE_EVM_ARTIFACTS.mockUsdc.abi, "mint", [depositor, s.amount]);
  await ensurePermit2Allowance({
    allowance: () =>
      l1.publicClient.readContract({ address: m.l1.usdc, abi: erc20Abi, functionName: "allowance", args: [depositor, m.l1.permit2] }),
    approveMax: async () =>
      (await writeEvm(l1, "Permit2 approval", m.l1.usdc, [...erc20Abi], "approve", [m.l1.permit2, maxUint256])).transactionHash,
    waitReceipt: (hash) => l1.publicClient.waitForTransactionReceipt({ hash }),
    needed: s.amount,
  });

  const l1Ctx = { publicClient: l1.publicClient, walletClient: l1.walletClient, account: depositor };
  // The permit deadline counts from L1 time, not this machine's clock.
  const l1Now = (await l1.publicClient.getBlock()).timestamp;
  const draft = await prepareDeposit({ amount: s.amount, recipient: s.payer, kind: "private" }, m, () => l1Now);
  await submitDeposit(draft, l1Ctx, m, s.node);
  const ticket = await confirmDeposit(draft, l1Ctx, m);
  s.log(`  Deposited on L1 in ${draft.l1TxHash}; waiting for the message to reach Aztec...`);

  // A local network builds a block only when a tx arrives, so the message needs traffic to become claimable.
  const beater = await createPXEWallet(s.node, { ephemeral: true, pxe: { proverEnabled: false } });
  await registerSponsor(beater, m);
  const stopHeartbeat = await startBlockHeartbeat(beater, m);
  try {
    // The payer's first claim binds it to the depositor for good; here both are local test accounts.
    await waitClaimable(ticket, s.node, s.wallet, m, s.payer, undefined, { allowBind: true, pollMs: 2_000, attempts: 300 });
    const result = await claim(ticket, s.node, s.wallet, m, { from: s.payer, allowBind: true });
    if (result !== "claimed") throw new Error(`The funding claim returned ${result}.`);
  } finally {
    await stopHeartbeat();
    await beater.stop();
  }
}

/** Returns the token to charge in: the local bridge's USDC, with the merchant listed and the payer funded. */
export async function setupInferenceToken(s: InferenceSetup): Promise<{ tokenAddress: string }> {
  const chainId = await l1ChainId(s.l1RpcUrl);
  const l1 = l1Signer(s.l1RpcUrl, chainId, mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: ANVIL_ACCOUNT_INDEX }));
  const { manifest, admin } = await loadOrDeploy(s, l1);
  await registerSponsor(s.wallet, manifest);
  await registerBridgeContracts(s.wallet, manifest);
  const token = AztecAddress.fromStringUnsafe(manifest.l2.token.address);

  if (merchantStatus(await syncMerchantList(s.node, token), s.merchant).merchant) {
    s.log("Server is already a listed merchant — skipping.");
  } else {
    // A real merchant binds its treasury with a first private claim before it is listed; a local demo skips that.
    s.log(`Listing the server ${s.merchant} as a merchant...`);
    await addMerchants({ wallet: s.wallet, m: manifest, node: s.node }, admin, [s.merchant]);
  }

  const balance = await l2UsdcBalance(s.wallet, manifest, s.payer, "private");
  if (balance >= s.amount) {
    s.log(`Payer already holds ${balance} — skipping.`);
  } else {
    s.log(`Funding the payer with ${s.amount} over the bridge...`);
    await fundPayer(s, l1, manifest);
    s.log(`  Payer's balance: ${await l2UsdcBalance(s.wallet, manifest, s.payer, "private")}`);
  }
  return { tokenAddress: manifest.l2.token.address };
}

async function l1ChainId(rpcUrl: string): Promise<number> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  const { result } = await response.json();
  return Number(BigInt(result));
}
