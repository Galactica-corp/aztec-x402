import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { filePaymentStore } from "../aztec/tokens/payment-store.js";

const newPath = () => join(mkdtempSync(join(tmpdir(), "x402-store-")), "requests.json");

describe("filePaymentStore", () => {
  test("records survive the process: a second store on the same file reads them", async () => {
    const path = newPath();
    const first = filePaymentStore(path);
    await first.put("token:1", { state: "paid", txHash: "0xaa" });
    await first.put("token:2", { state: "paid", txHash: "0xbb" });
    await first.put("token:2", undefined);

    const second = filePaymentStore(path);
    expect(await second.get("token:1")).toEqual({ state: "paid", txHash: "0xaa" });
    expect(await second.get("token:2")).toBeUndefined();
  });

  test("the lock excludes other processes: two stores never run their critical sections together", async () => {
    const path = newPath();
    const stores = [filePaymentStore(path), filePaymentStore(path)];
    let inside = 0;
    let overlapped = false;
    await Promise.all(
      [0, 1, 0, 1].map((i) =>
        stores[i].locked("k", async () => {
          if (++inside > 1) overlapped = true;
          await new Promise((resolve) => setTimeout(resolve, 20));
          inside--;
        }),
      ),
    );
    expect(overlapped).toBe(false);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("releases the lock when the critical section throws", async () => {
    const store = filePaymentStore(newPath());
    await expect(store.locked("k", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await store.locked("k", async () => "next")).toBe("next");
  });

  test("takes over a lock left by a process that died", async () => {
    const path = newPath();
    writeFileSync(`${path}.lock`, "");
    const longAgo = new Date(Date.now() - 10 * 60_000);
    utimesSync(`${path}.lock`, longAgo, longAgo);
    expect(await filePaymentStore(path).locked("k", async () => "ran")).toBe("ran");
  });
});
