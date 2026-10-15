import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync } from "fs";
import { decodeFunctionData } from "viem";
import { FeeAssetHandlerAbi } from "@aztec-foundation/l1-artifacts/FeeAssetHandlerAbi";
import { FeeJuicePortalAbi } from "@aztec-foundation/l1-artifacts/FeeJuicePortalAbi";
import { TestERC20Abi } from "@aztec-foundation/l1-artifacts/TestERC20Abi";
import { FeeJuiceBridge } from "../fund/fee-juice.js";
import { OWNER_WORD, toHex } from "../fund/bridge.js";
import { completeDeposit } from "../fund/process.js";
import type { Session } from "../aztec/session.js";
import { publicView, readDeposits, type DepositRecord } from "../fund/deposits.js";
import { startFundServer, type FundServer } from "../fund/server.js";
import { buildPlan, encodePlan } from "../commands/fund.js";
import { FUND_PAGE_HTML } from "../fund/page.generated.js";
import { FUND_PAGE_SOURCE, renderModule, FUND_PAGE_MODULE } from "../fund/page-source.js";
import type { ResolvedContext } from "../config.js";

const addresses = {
  portal: toHex("0xb4a9f8eadc8ca944729d61e59a9f491faff237a3"),
  token: toHex("0x762c132040fda6183066fa3b14d985ee55aa3c18"),
  handler: toHex("0x5602c39a6e9c5ace589f64f754927bcda4f4bfc9"),
};
const AGENT = "0x0745f1699dc54282bd7a950598c1b55ab433d631a4cc9b0373065122849152a2";
const OWNER = "0x000000000000000000000000000000000000dEaD";

const record: DepositRecord = {
  id: "d1",
  bridge: "fee-juice",
  recipient: AGENT,
  amount: (100n * 10n ** 18n).toString(),
  secret: "0x0bad",
  secretHash: "0x027bf69ba6bd1c1af1b1b1e67d404e346acd0d0611984660fcfc13e9384a38c0",
  status: "awaiting_l1",
  createdAt: "now",
  l1FromBlock: "1",
};

/** What the page does: put the connected account into the calldata. */
function fill(data: string, owner = OWNER) {
  return toHex(data.split(OWNER_WORD).join(owner.slice(2).toLowerCase().padStart(64, "0")));
}

const bridge = FeeJuiceBridge.fromAddresses("http://127.0.0.1:1", addresses);

describe("fee juice funding steps", () => {
  const steps = bridge.steps(record);

  test("mint (repeating until funded), approve, deposit — in that order", () => {
    expect(steps.map((s) => s.id)).toEqual(["mint", "approve", "deposit"]);
    expect(steps[0].repeat).toBe(true);
    expect(steps[0].skipIf?.gte).toBe(record.amount);
  });

  test("owner-dependent calldata carries the placeholder and fills to the right call", () => {
    const mint = decodeFunctionData({ abi: FeeAssetHandlerAbi, data: fill(steps[0].data) });
    expect(mint.functionName).toBe("mint");
    expect(String(mint.args?.[0]).toLowerCase()).toBe(OWNER.toLowerCase());

    const balance = decodeFunctionData({ abi: TestERC20Abi, data: fill(steps[0].skipIf?.data ?? "") });
    expect(balance.functionName).toBe("balanceOf");

    const allowance = decodeFunctionData({ abi: TestERC20Abi, data: fill(steps[1].skipIf?.data ?? "") });
    expect(allowance.functionName).toBe("allowance");
    expect(String(allowance.args?.[1]).toLowerCase()).toBe(addresses.portal);
  });

  test("approve and deposit are owner-independent and target the portal", () => {
    expect(steps[1].data.includes(OWNER_WORD)).toBe(false);
    const approve = decodeFunctionData({ abi: TestERC20Abi, data: toHex(steps[1].data) });
    expect(approve.args).toEqual([expect.stringMatching(/^0x/i), BigInt(record.amount)]);

    const deposit = decodeFunctionData({ abi: FeeJuicePortalAbi, data: toHex(steps[2].data) });
    expect(deposit.functionName).toBe("depositToAztecPublic");
    expect(deposit.args).toEqual([AGENT, BigInt(record.amount), record.secretHash]);
    expect(steps[2].to).toBe(addresses.portal);
  });

  test("no faucet step when the network has no fee asset handler", () => {
    const noFaucet = FeeJuiceBridge.fromAddresses("http://127.0.0.1:1", { ...addresses, handler: undefined });
    expect(noFaucet.steps(record).map((s) => s.id)).toEqual(["approve", "deposit"]);
  });
});

describe("funding plan", () => {
  const ctx: ResolvedContext = {
    network: {
      name: "testnet",
      caip2: "aztec:testnet",
      nodeUrl: "http://node",
      proverEnabled: true,
      sponsoredFees: true,
      l1ChainId: 11155111,
      l1ChainName: "Sepolia",
      l1RpcUrl: "http://l1",
      tokens: [],
    },
    policy: { maxPerPayment: "1", dailyLimit: "5" },
    dataDir: "/tmp",
  };

  test("round-trips through the URL fragment and never carries the secret", async () => {
    const plan = buildPlan(ctx, bridge, await bridge.describe(), record);
    const fragment = encodePlan(plan);
    expect(fragment).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(fragment, "base64url").toString())).toEqual(plan);
    expect(JSON.stringify(plan)).not.toContain(record.secret);
    expect(plan).toMatchObject({ v: 1, agent: AGENT, amount: "100", l1ChainId: 11155111 });
    // Comfortably inside URL limits of browsers and chat apps.
    expect(fragment.length).toBeLessThan(4000);
  });
});

describe("funding page", () => {
  test("the CLI's embedded page is the skill's assets/fund.html", () => {
    const source = readFileSync(FUND_PAGE_SOURCE, "utf-8");
    expect(FUND_PAGE_HTML).toBe(source);
    expect(readFileSync(FUND_PAGE_MODULE, "utf-8")).toBe(renderModule(source));
  });
});

describe("fund server", () => {
  let server: FundServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const submitted: string[] = [];
  const api = {
    state: async () => ({ phase: "signing" }),
    submitted: async (body: { l1TxHash: string; owner: string }) => {
      submitted.push(body.l1TxHash);
      return { accepted: true };
    },
  };

  function split(url: string) {
    const parsed = new URL(url);
    return { base: `${parsed.protocol}//${parsed.host}`, token: parsed.searchParams.get("t") ?? "" };
  }

  test("serves the skill page and refuses requests without the token", async () => {
    server = await startFundServer(api, {});
    const { base, token } = split(server.url);
    expect(server.url.startsWith("http://127.0.0.1:")).toBe(true);
    expect(server.networkUrls).toEqual([]);
    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(FUND_PAGE_HTML);
    expect((await fetch(`${base}/api/state`)).status).toBe(403);
    expect((await fetch(`${base}/api/state?t=wrong`)).status).toBe(403);
    expect(await (await fetch(`${base}/api/state?t=${token}`)).json()).toEqual({ phase: "signing" });
  });

  test("validates the reported deposit before accepting it", async () => {
    server = await startFundServer(api, {});
    const { base, token } = split(server.url);
    const post = (body: unknown) =>
      fetch(`${base}/api/submitted?t=${token}`, { method: "POST", body: JSON.stringify(body) });
    expect((await post({ l1TxHash: "0xnothex", owner: OWNER })).status).toBe(400);
    expect((await post({ l1TxHash: "0x" + "ab".repeat(32), owner: "0x12" })).status).toBe(400);
    expect((await post({ l1TxHash: "0x" + "ab".repeat(32), owner: OWNER })).status).toBe(200);
    expect(submitted).toEqual(["0x" + "ab".repeat(32)]);
  });

  test("bound to all interfaces, it lists reachable URLs besides localhost", async () => {
    server = await startFundServer(api, { host: "0.0.0.0" });
    expect(server.url.startsWith("http://localhost:")).toBe(true);
    for (const url of server.networkUrls) expect(url).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/\?t=/);
  });
});

test("publicView never exposes the claim secret", () => {
  expect(JSON.stringify(publicView(record))).not.toContain(record.secret);
});

describe("completeDeposit", () => {
  function timeoutError(): Error {
    const error = new Error("Timed out while waiting for transaction");
    error.name = "WaitForTransactionReceiptTimeoutError";
    return error;
  }
  const unminedBridge = FeeJuiceBridge.fromAddresses("http://127.0.0.1:1", addresses);
  unminedBridge.readDeposit = async () => {
    throw timeoutError();
  };
  const noSession = (): Promise<Session> => Promise.reject(new Error("session must not be opened"));

  test("gives up on an L1 transaction that is still unmined an hour later", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "x402-fund-"));
    const stale = { ...record, l1TxHash: "0x" + "03".padStart(64, "0"), createdAt: new Date(Date.now() - 2 * 3600_000).toISOString() };
    await expect(
      completeDeposit(stale, unminedBridge, noSession, dataDir),
    ).rejects.toMatchObject({ code: "l1_not_mined" });
    expect(readDeposits(dataDir)[0].status).toBe("failed");
  });

  test("keeps a fresh unmined deposit resumable", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "x402-fund-"));
    const fresh = { ...record, l1TxHash: "0x" + "04".padStart(64, "0"), createdAt: new Date().toISOString() };
    await expect(
      completeDeposit(fresh, unminedBridge, noSession, dataDir),
    ).rejects.toThrow(/Timed out/);
    expect(readDeposits(dataDir)[0].status).toBe("awaiting_l1");
  });
});
