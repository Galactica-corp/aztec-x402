import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkStorage,
  deriveRefSecret,
  LEGACY_SECRET_FILE,
  merchantRoutes,
  PXE_DIR,
  resolveRefSecret,
  STORE_FILE,
  stopOnSignals,
} from "../aztec/merchant.js";

const KEY = "0x" + "1f".repeat(32);
const OTHER_KEY = "0x" + "2e".repeat(32);
const ADDRESS = "0x" + "0a".repeat(32);

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "x402-merchant-"));
  dirs.push(d);
  return d;
}

describe("the reference secret", () => {
  test("is derived from the secret key: the same every time, 32 bytes, bound to key and address", () => {
    const secret = deriveRefSecret(KEY, ADDRESS);
    expect(secret).toHaveLength(32);
    expect(deriveRefSecret(KEY, ADDRESS)).toEqual(secret);
    expect(deriveRefSecret(KEY, ADDRESS.toUpperCase().replace("0X", "0x"))).toEqual(secret);
    expect(deriveRefSecret(OTHER_KEY, ADDRESS)).not.toEqual(secret);
    expect(deriveRefSecret(KEY, "0x" + "0b".repeat(32))).not.toEqual(secret);
  });

  test("comes from the option first, then a legacy file in the data folder, then the keys", () => {
    const d = dir();
    const explicit = new Uint8Array(32).fill(7);
    expect(resolveRefSecret({ secret: explicit, dataDir: d, secretKey: KEY, address: ADDRESS })).toEqual({ secret: explicit, source: "option" });
    expect(resolveRefSecret({ dataDir: d, secretKey: KEY, address: ADDRESS })).toEqual({ secret: deriveRefSecret(KEY, ADDRESS), source: "derived" });
    writeFileSync(join(d, LEGACY_SECRET_FILE), "ab".repeat(32) + "\n");
    const fromFile = resolveRefSecret({ dataDir: d, secretKey: KEY, address: ADDRESS });
    expect(fromFile.source).toBe("file");
    expect(Buffer.from(fromFile.secret).toString("hex")).toBe("ab".repeat(32));
  });
});

describe("the storage check", () => {
  test("tells a fresh folder, a kept one, and one that lost half of its storage", () => {
    const d = dir();
    expect(checkStorage(d)).toBe("fresh");
    writeFileSync(join(d, STORE_FILE), "");
    expect(checkStorage(d)).toBe("wallet-lost");
    mkdirSync(join(d, PXE_DIR));
    expect(checkStorage(d)).toBe("ok");
    rmSync(join(d, STORE_FILE));
    expect(checkStorage(d)).toBe("store-lost");
    // With a store elsewhere (a shared database), only the wallet's store is looked at.
    expect(checkStorage(d, false)).toBe("ok");
    expect(checkStorage(join(d, "missing"), false)).toBe("fresh");
  });
});

describe("merchant routes", () => {
  test("need only an amount; the merchant fills in the rest, and what a route sets wins", () => {
    const routes = merchantRoutes(
      { "/a": { amount: "10" }, "/b": { amount: "20", modes: ["commitment"], maxTimeoutSeconds: 60, description: "b" } },
      { network: "aztec:testnet", asset: "0xtoken", payTo: "0xme", modes: ["ref", "split", "commitment"] },
    );
    expect(routes["/a"]).toEqual({ network: "aztec:testnet", asset: "0xtoken", payTo: "0xme", modes: ["ref", "split", "commitment"], amount: "10", maxTimeoutSeconds: 600 });
    expect(routes["/b"]).toMatchObject({ amount: "20", modes: ["commitment"], maxTimeoutSeconds: 60, description: "b", payTo: "0xme" });
  });
});

describe("shutdown", () => {
  function fakeProcess() {
    const listeners = new Map<string, () => void>();
    return {
      pid: 42,
      listeners,
      once: (s: string, l: () => void) => void listeners.set(s, l),
      off: (s: string, l: () => void) => void (listeners.get(s) === l && listeners.delete(s)),
      kill: mock((_pid: number, _signal: string) => {}),
    };
  }

  test("stops the jobs on SIGTERM, then raises the signal again so the process exits as usual", async () => {
    const proc = fakeProcess();
    const order: string[] = [];
    stopOnSignals(async () => void order.push("stop"), proc);
    expect([...proc.listeners.keys()]).toEqual(["SIGTERM", "SIGINT"]);
    proc.listeners.get("SIGTERM")?.();
    expect(proc.listeners.size).toBe(0); // a second signal is not caught again
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["stop"]);
    expect(proc.kill).toHaveBeenCalledWith(42, "SIGTERM");
  });

  test("still exits when stopping fails, and can be unhooked", async () => {
    const proc = fakeProcess();
    stopOnSignals(async () => Promise.reject(new Error("busy")), proc);
    proc.listeners.get("SIGINT")?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(proc.kill).toHaveBeenCalledWith(42, "SIGINT");

    const other = fakeProcess();
    stopOnSignals(async () => {}, other)();
    expect(other.listeners.size).toBe(0);
  });
});
