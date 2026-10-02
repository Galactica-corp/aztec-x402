import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isProverError, proverFailed } from "../errors.js";
import { setInflightPayment } from "../inflight.js";
import { appendLedger, readLedger } from "../policy.js";
import { reportError } from "../main.js";
import { resetOutput } from "../output.js";

function bbError(message: string): Error {
  const error = new Error(message);
  error.name = "BBApiException";
  return error;
}

describe("prover errors", () => {
  test("recognises Barretenberg failures, including CRS download problems", () => {
    expect(isProverError(bbError("anything"))).toBe(true);
    expect(isProverError(new Error("Failed to download CRS"))).toBe(true);
    expect(isProverError(new Error("fetch failed"))).toBe(false);
    expect(isProverError("not an error")).toBe(false);
  });

  test("map to prover_failed stating nothing was submitted", () => {
    const error = proverFailed(bbError("boom"));
    expect(error.code).toBe("prover_failed");
    expect(error.details).toEqual({ txSubmitted: false });
  });
});

describe("reportError", () => {
  beforeEach(() => resetOutput());
  afterEach(() => setInflightPayment(undefined));

  function capture(fn: () => number) {
    const chunks: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      const code = fn();
      return { code, out: JSON.parse(chunks.join("")) };
    } finally {
      spy.mockRestore();
    }
  }

  test("an escaped prover failure still yields one JSON document and settles the payment as failed", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "x402-err-"));
    appendLedger(dataDir, { id: "p1", status: "pending", amountBaseUnits: "10000" });
    setInflightPayment({ dataDir, id: "p1" });

    const { code, out } = capture(() => reportError(bbError("CRS download failed")));
    expect(code).toBe(1);
    expect(out).toMatchObject({ ok: false, error: { code: "prover_failed", txSubmitted: false } });
    expect(readLedger(dataDir)[0].status).toBe("failed");
  });

  test("any other escaped failure during a payment marks it uncertain", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "x402-err-"));
    appendLedger(dataDir, { id: "p2", status: "pending", amountBaseUnits: "10000" });
    setInflightPayment({ dataDir, id: "p2" });

    const { out } = capture(() => reportError(new Error("socket hang up")));
    expect(out).toMatchObject({ ok: false, error: { code: "unexpected" } });
    expect(readLedger(dataDir)[0].status).toBe("uncertain");
  });
});
