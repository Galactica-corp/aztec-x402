import { afterEach, describe, expect, test } from "bun:test";
import { startFundServer, type FundServer } from "../fund/server.js";
import { publicView, type DepositRecord } from "../fund/deposits.js";

let server: FundServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const calls: string[] = [];
const api = {
  state: async () => ({ phase: "signing" }),
  prepare: async (owner: string) => {
    calls.push(`prepare:${owner}`);
    return { txs: [] };
  },
  submitted: async (body: { l1TxHash: string; owner: string }) => {
    calls.push(`submitted:${body.l1TxHash}`);
    return { accepted: true };
  },
};

function split(url: string) {
  const parsed = new URL(url);
  return { base: `${parsed.protocol}//${parsed.host}`, token: parsed.searchParams.get("t") ?? "" };
}

describe("fund server", () => {
  test("serves the page with its token and refuses requests without it", async () => {
    server = await startFundServer(api, {});
    const { base, token } = split(server.url);
    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(JSON.stringify(token));
    expect((await fetch(`${base}/api/state`)).status).toBe(403);
    expect((await fetch(`${base}/api/state?t=wrong`)).status).toBe(403);
    expect(await (await fetch(`${base}/api/state?t=${token}`)).json()).toEqual({ phase: "signing" });
  });

  test("validates hex inputs before calling the api", async () => {
    server = await startFundServer(api, {});
    const { base, token } = split(server.url);
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}?t=${token}`, { method: "POST", body: JSON.stringify(body) });

    expect((await post("/api/prepare", { owner: "0x1234" })).status).toBe(400);
    const owner = "0x000000000000000000000000000000000000dEaD";
    expect((await post("/api/prepare", { owner })).status).toBe(200);
    expect((await post("/api/submitted", { l1TxHash: "0xnothex", owner })).status).toBe(400);
    expect((await post("/api/submitted", { l1TxHash: "0x" + "ab".repeat(32), owner })).status).toBe(200);
    expect(calls).toEqual([`prepare:${owner}`, `submitted:0x${"ab".repeat(32)}`]);
  });

  test("binds to loopback by default", async () => {
    server = await startFundServer(api, {});
    expect(server.url.startsWith("http://127.0.0.1:")).toBe(true);
  });
});

test("publicView never exposes the claim secret", () => {
  const record: DepositRecord = {
    id: "1",
    bridge: "fee-juice",
    recipient: "0x01",
    amount: "1",
    secret: "0xsecret",
    secretHash: "0xhash",
    status: "awaiting_l1",
    createdAt: "now",
  };
  expect(JSON.stringify(publicView(record))).not.toContain("0xsecret");
});
