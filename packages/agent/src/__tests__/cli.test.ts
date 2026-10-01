import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { main } from "../main.js";

let previousHome: string | undefined;
beforeAll(() => {
  previousHome = process.env.AZTEC_X402_HOME;
  process.env.AZTEC_X402_HOME = mkdtempSync(join(tmpdir(), "x402-cli-"));
});
afterAll(() => {
  if (previousHome === undefined) delete process.env.AZTEC_X402_HOME;
  else process.env.AZTEC_X402_HOME = previousHome;
});

/** Run the CLI in-process and capture its single JSON document. */
async function run(argv: string[]): Promise<{ code: number; out: Record<string, unknown> }> {
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

describe("cli", () => {
  test("pay without --max-amount is a usage error (exit 2)", async () => {
    const { code, out } = await run(["pay", "http://example.com"]);
    expect(code).toBe(2);
    expect(out).toMatchObject({ ok: false, error: { code: "usage" } });
  });

  test("unknown flags are usage errors, not crashes", async () => {
    const { code, out } = await run(["status", "--bogus"]);
    expect(code).toBe(2);
    expect(out).toMatchObject({ ok: false, error: { code: "usage" } });
  });

  test("wallet show without a wallet says how to create one", async () => {
    const { code, out } = await run(["wallet", "show"]);
    expect(code).toBe(2);
    expect(out).toMatchObject({ ok: false, error: { code: "no_wallet" } });
  });

  test("unknown network is a usage error", async () => {
    const { code } = await run(["status", "--network", "mainnet-ish"]);
    expect(code).toBe(2);
  });

  test("config set validates keys and amounts", async () => {
    expect((await run(["config", "set", "policy.dailyLimit", "lots"])).code).toBe(2);
    expect((await run(["config", "set", "nonsense", "1"])).code).toBe(2);
    const { code, out } = await run(["config", "set", "policy.dailyLimit", "3"]);
    expect(code).toBe(0);
    expect(out).toMatchObject({ ok: true, config: { policy: { dailyLimit: "3" } } });
  });
});
