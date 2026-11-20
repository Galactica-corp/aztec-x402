/**
 * USDC deposits and withdrawals: the page plans the user signs, and the
 * records that hold the only copy of a claim salt or an exit ticket.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { TxHash } from "@aztec-labs/aztec.js/tx";
import { TOKEN_PORTAL_ABI, prepareDeposit, type ExitTicket } from "@galactica-net/inference-money-core";
import { MAINNET_MANIFEST } from "@galactica-net/inference-money-core/deployments";
import { decodeFunctionData, getAddress } from "viem";
import { encodePlan } from "../commands/fund.js";
import { toHex } from "../fund/bridge.js";
import { SIGNATURE_WORD } from "../fund/split.js";
import {
  buildUsdcDepositPlan,
  buildWithdrawPlan,
  isOpenWithdrawal,
  readUsdcWithdrawals,
  saveUsdcWithdrawal,
  type UsdcWithdrawalRecord,
} from "../fund/usdc.js";
import { main } from "../main.js";
import { NETWORKS } from "../networks.js";

const m = MAINNET_MANIFEST;
const network = NETWORKS.mainnet;
if (!network) throw new Error("no mainnet network");
const AGENT = `0x${"11".repeat(32)}`;
const FUNDING = "0x00000000000000000000000000000000000f00d1";
const fmt = (v: bigint) => (Number(v) / 1e6).toString();

async function draft() {
  return prepareDeposit({ amount: 2_500_000n, recipient: AztecAddress.fromStringUnsafe(AGENT), kind: "private" }, m, () => 1_800_000_000n);
}

describe("USDC deposit plan", () => {
  test("approve Permit2 once, sign the permit, send the private deposit to the router", async () => {
    const plan = buildUsdcDepositPlan(network, m, await draft(), AGENT, fmt);
    expect(plan.kind).toBe("fund");
    expect(plan.steps.map((s) => s.id)).toEqual(["approve", "permit", "deposit"]);
    expect(plan.steps[0]?.to).toBe(m.l1.usdc);
    expect(plan.steps[1]?.kind).toBe("sign");
    expect(plan.steps[2]?.to).toBe(m.l1.router);
    expect(plan.steps[2]?.data).toContain(SIGNATURE_WORD);
    expect(plan.amount).toBe("2.5");
    expect(plan.l1ChainId).toBe(1);
  });

  test("an unbound account's plan says the deposit binds it; a bound one's pins the signer", async () => {
    const unbound = buildUsdcDepositPlan(network, m, await draft(), AGENT, fmt);
    expect(unbound.from).toBeUndefined();
    expect(unbound.privacy).toContain("binds");
    const bound = buildUsdcDepositPlan(network, m, await draft(), AGENT, fmt, FUNDING);
    expect(bound.from).toBe(FUNDING);
    expect(bound.privacy).toContain(FUNDING);
  });

  test("the plan travels in a URL without the claim salt", async () => {
    const d = await draft();
    const encoded = encodePlan(buildUsdcDepositPlan(network, m, d, AGENT, fmt));
    expect(Buffer.from(encoded, "base64url").toString()).not.toContain(d.secretOrSalt.toString().slice(2));
  });
});

describe("USDC withdraw plan", () => {
  const ticket: ExitTicket = {
    l2TxHash: TxHash.random(),
    recipient: FUNDING,
    amount: 1_000_000n,
    messageHash: `0x${"ab".repeat(32)}`,
    messageIndexInTx: 0,
  };
  const path: `0x${string}`[] = [`0x${"cd".repeat(32)}`];
  const proof = { epoch: 7n, numCheckpointsInEpoch: 3n, leafIndex: 5n, path };

  test("one transaction: the portal's withdraw to the ticket's recipient, with the proof", () => {
    const plan = buildWithdrawPlan(network, m, ticket, proof, AGENT, fmt);
    expect(plan.kind).toBe("withdraw");
    expect(plan.steps).toHaveLength(1);
    const [step] = plan.steps;
    if (!step) throw new Error("no step");
    expect(step.to).toBe(m.l1.portal);
    const call = decodeFunctionData({ abi: TOKEN_PORTAL_ABI, data: toHex(step.data) });
    expect(call.functionName).toBe("withdraw");
    expect(call.args).toEqual([getAddress(FUNDING), 1_000_000n, false, 7n, 3n, 5n, proof.path]);
  });
});

describe("withdrawal records", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-usdc-"));
  const base: UsdcWithdrawalRecord = {
    id: "w1",
    createdAt: new Date(0).toISOString(),
    from: AGENT,
    recipient: FUNDING,
    amount: "1000000",
    asMerchant: false,
    status: "exiting",
  };

  test("a record is updated in place, and the file is private", () => {
    saveUsdcWithdrawal(dir, base);
    saveUsdcWithdrawal(dir, { ...base, status: "unconfirmed", l2TxHash: "0x01" });
    saveUsdcWithdrawal(dir, { ...base, id: "w2", status: "withdrawn" });
    const all = readUsdcWithdrawals(dir);
    expect(all.map((r) => [r.id, r.status])).toEqual([
      ["w1", "unconfirmed"],
      ["w2", "withdrawn"],
    ]);
    expect(statSync(join(dir, "usdc-withdrawals.json")).mode & 0o777).toBe(0o600);
  });

  test("a burn that may have happened or is not paid out yet blocks a second withdrawal", () => {
    for (const status of ["exiting", "unconfirmed", "exited"] as const) expect(isOpenWithdrawal({ ...base, status })).toBe(true);
    for (const status of ["withdrawn", "reverted", "unknown"] as const) expect(isOpenWithdrawal({ ...base, status })).toBe(false);
  });
});

describe("cli: deposit and withdraw", () => {
  let previousHome: string | undefined;
  beforeAll(() => {
    previousHome = process.env.AZTEC_X402_HOME;
    process.env.AZTEC_X402_HOME = mkdtempSync(join(tmpdir(), "x402-cli-usdc-"));
  });
  afterAll(() => {
    if (previousHome === undefined) delete process.env.AZTEC_X402_HOME;
    else process.env.AZTEC_X402_HOME = previousHome;
  });

  async function run(argv: string[]) {
    const chunks: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      const code = await main([...argv, "--quiet"]);
      return { code, out: JSON.parse(chunks.join("")) };
    } finally {
      spy.mockRestore();
    }
  }

  test("deposit without a wallet says how to create one", async () => {
    const { code, out } = await run(["deposit", "--amount", "1"]);
    expect(code).toBe(2);
    expect(out.error.code).toBe("no_wallet");
  });

  test("withdraw needs an amount and a valid --to, before touching the network", async () => {
    expect((await run(["withdraw"])).code).toBe(2);
    const bad = await run(["withdraw", "--amount", "1", "--to", "nope"]);
    expect(bad.code).toBe(2);
    expect(bad.out.error.message).toContain("--to");
  });

  test("unknown subcommands are usage errors", async () => {
    expect((await run(["deposit", "bogus"])).code).toBe(2);
    expect((await run(["withdraw", "bogus"])).code).toBe(2);
  });
});
