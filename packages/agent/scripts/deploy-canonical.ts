/**
 * Ensure the canonical Dripper faucet and USDC token exist on a network.
 *
 * Both are universal deploys (deployer = 0) with salt 1337 — the convention of
 * @aztec-foundation/aztec-standards — so their addresses depend only on the
 * artifacts and constructor args and are the same for everyone. USDC's minter
 * is the Dripper, so anyone can drip testnet USDC to themselves.
 *
 * Addresses printed here (and hard-coded in src/networks.ts) follow the
 * 6.0.0-rc.1 artifacts.
 *
 * Safe to re-run: contracts already on-chain are skipped. Fees are paid from
 * the agent wallet of the selected network via Sponsored FPC.
 *
 * Usage: bun run scripts/deploy-canonical.ts [--network testnet] [--dry-run]
 */
import { parseArgs } from "util";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr } from "@aztec-labs/aztec.js/fields";
import type { DeployMethod } from "@aztec-labs/aztec.js/contracts";
import { TokenContract } from "@aztec-foundation/aztec-standards/dist/src/artifacts/Token.js";
import { DripperContract } from "@aztec-foundation/aztec-standards/dist/src/artifacts/Dripper.js";
import { resolveContext } from "../src/config.js";
import { openSession } from "../src/aztec/session.js";
import { walletCreate } from "../src/commands/wallet.js";

const CANONICAL_SALT = new Fr(1337);
const USDC = { name: "USDC", symbol: "USDC", decimals: 6 };

const { values } = parseArgs({
  options: { network: { type: "string" }, "dry-run": { type: "boolean" } },
});
const ctx = resolveContext(values.network);
const log = (msg: string) => console.error(msg);

log(`Network: ${ctx.network.name} (${ctx.network.nodeUrl})`);
const wallet = await walletCreate(ctx);
log(`Deployer (agent wallet): ${wallet.address}`);
const session = await openSession(ctx.network, ctx.dataDir);

async function ensureDeployed(label: string, deploy: DeployMethod<unknown>): Promise<AztecAddress> {
  const instance = await deploy.getInstance();
  const address = instance.address;
  if (await session.node.getContract(address)) {
    log(`${label} already deployed at ${address}`);
    return address;
  }
  if (values["dry-run"]) {
    log(`${label} NOT deployed (would deploy at ${address})`);
    return address;
  }
  const classPublished = (await session.node.getContractClass(instance.currentContractClassId)) !== undefined;
  log(`Deploying ${label} at ${address} (class ${classPublished ? "already published" : "new"})...`);
  const started = Date.now();
  await deploy.send({ ...session.sendOpts, skipClassPublication: classPublished });
  log(`  done in ${Math.round((Date.now() - started) / 1000)}s`);
  return address;
}

const dripper = await ensureDeployed(
  "Dripper",
  DripperContract.deploy(session.wallet, { salt: CANONICAL_SALT, universalDeploy: true }),
);

const usdc = await ensureDeployed(
  "USDC",
  TokenContract.deployWithOpts(
    {
      wallet: session.wallet,
      method: "constructor_with_minter",
      instantiation: { salt: CANONICAL_SALT, universalDeploy: true },
    },
    USDC.name,
    USDC.symbol,
    USDC.decimals,
    dripper,
    AztecAddress.ZERO,
  ),
);

console.log(JSON.stringify({ network: ctx.network.name, dripper: dripper.toString(), usdc: usdc.toString() }, null, 2));
process.exit(0);
