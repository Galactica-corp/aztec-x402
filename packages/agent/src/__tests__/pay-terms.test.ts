/**
 * The client binds a prepare response to the 402 it parsed. This command
 * approved a different quote. Paying the prepared one would still pass the
 * spend cap, and the ledger would record the approved price.
 */
import { expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import * as realClient from "@galactica-net/x402-client";
import * as realSession from "../aztec/session.js";

// The canonical testnet tUSDC (AIP-20): a payment to it needs no merchant listing.
const TUSDC = "0x08b5c7a74699f9336cb31f42872d9f067f52aef34afe2d2eb34dd0c3e3b36358";
const PAY_TO_A = "0x0" + "a".repeat(63);
const PAY_TO_B = "0x0" + "b".repeat(63);
const transfers: unknown[] = [];

const swapped = {
  scheme: "exact",
  network: "aztec:testnet",
  asset: TUSDC,
  amount: "40000",
  payTo: PAY_TO_B,
  maxTimeoutSeconds: 120,
  extra: { nonce: "n-2", commitment: "0x" + "ff".repeat(32) },
};

// Module mocks last for the whole test run, so each keeps the real exports
// and only replaces what this test needs. The real client signer pays through
// the token below, which records any transfer.
const token = {
  preflight: async () => {},
  pay: async (...args: unknown[]) => {
    transfers.push(args);
    return "0x" + "cc".repeat(32);
  },
};
mock.module(join(import.meta.dir, "../aztec/session.ts"), () => ({
  ...realSession,
  openSession: async () => ({ account: { address: PAY_TO_A }, tokens: { get: async () => token }, fee: undefined }),
  tokenAt: async () => token,
}));

mock.module("@galactica-net/x402-client", () => ({
  ...realClient,
  // The client has already accepted a prepare bound to a different 402.
  wrapFetchWithPayment(
    _fetchFn: unknown,
    scheme: { createPaymentPayload: (version: number, requirements: typeof swapped) => Promise<unknown> },
  ) {
    return async () => {
      await scheme.createPaymentPayload(2, swapped);
      return Response.json({ weather: "clear" });
    };
  },
}));

const { main } = await import("../main.ts");

function challenge(amount: string, payTo: string): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "aztec:testnet",
          asset: TUSDC,
          amount,
          payTo,
          maxTimeoutSeconds: 120,
          extra: { nonce: "n-1" },
        },
      ],
    }),
  ).toString("base64");
}

test("a prepare quote the client accepted still has to match the approved 402", async () => {
  transfers.length = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return new Response("Payment Required", {
        status: 402,
        headers: { "PAYMENT-REQUIRED": challenge("10000", PAY_TO_A) },
      });
    },
  });
  const chunks: string[] = [];
  const spy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  const home = process.env.AZTEC_X402_HOME;
  process.env.AZTEC_X402_HOME = mkdtempSync(join(tmpdir(), "x402-pay-terms-"));
  try {
    const code = await main([
      "pay",
      `http://127.0.0.1:${server.port}/weather`,
      "--max-amount",
      "1",
      "--network",
      "testnet",
      "--quiet",
    ]);
    const out: unknown = JSON.parse(chunks.join(""));
    expect(code).toBe(3);
    expect(out).toMatchObject({
      ok: false,
      error: {
        code: "policy_rejected",
        message: "Prepared challenge differs from the original 402 challenge",
      },
    });
    expect(transfers).toEqual([]);
  } finally {
    spy.mockRestore();
    if (home === undefined) delete process.env.AZTEC_X402_HOME;
    else process.env.AZTEC_X402_HOME = home;
    server.stop(true);
  }
});
