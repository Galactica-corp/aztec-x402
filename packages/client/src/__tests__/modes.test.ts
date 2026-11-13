import { describe, expect, it, jest } from "bun:test";
import type { PaymentPayload, PaymentRequirements } from "@galactica-net/x402-mechanism";
import { sendPayment, wrapFetchWithPayment } from "../client.js";

const H = (b: string) => "0x" + b.repeat(32);
const ref: PaymentRequirements = {
  scheme: "exact",
  network: "aztec:sandbox",
  asset: H("dd"),
  amount: "10000",
  payTo: H("bb"),
  maxTimeoutSeconds: 60,
  extra: { nonce: "n1", mode: "ref", paymentRef: H("0f") },
};
const commitment: PaymentRequirements = { ...ref, extra: { nonce: "n1", mode: "commitment" } };

function challenge(accepts: PaymentRequirements[], extra: Record<string, unknown> = {}): Response {
  const body = { x402Version: 2, accepts, ...extra };
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(body)).toString("base64") },
  });
}

const headerOf = (init: RequestInit | undefined, key: string) => new Headers(init?.headers).get(key) ?? undefined;

function decode(init: RequestInit | undefined): PaymentPayload {
  return JSON.parse(Buffer.from(headerOf(init, "PAYMENT-SIGNATURE") ?? "", "base64").toString());
}

const scheme = (select = (a: PaymentRequirements[]) => a[0]) => ({
  scheme: "exact",
  getSenderAddress: jest.fn().mockResolvedValue(H("aa")),
  selectRequirement: jest.fn(select),
  createPaymentPayload: jest.fn().mockResolvedValue({ x402Version: 2, payload: { mode: "ref", txHash: H("cc") } }),
});

describe("ref payments through the wrapper", () => {
  it("skip the prepare phase and hand the payload to onPayload before sending it", async () => {
    const order: string[] = [];
    const fetchFn = jest.fn().mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (headerOf(init, "X-402-PREPARE")) throw new Error("no prepare expected");
      if (headerOf(init, "PAYMENT-SIGNATURE")) {
        order.push("send");
        return new Response("ok");
      }
      return challenge([ref, commitment]);
    });
    const s = scheme();
    const pay = wrapFetchWithPayment(fetchFn, s, {
      onPayload: (p) => {
        order.push(`persist:${p.accepted.extra.mode}`);
      },
    });
    const res = await pay("http://x/a");
    expect(await res.text()).toBe("ok");
    expect(order).toEqual(["persist:ref", "send"]);
    expect(s.createPaymentPayload).toHaveBeenCalledWith(2, ref);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("let the scheme choose the entry it can pay", async () => {
    const fetchFn = jest.fn().mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (headerOf(init, "X-402-PREPARE")) return challenge([{ ...commitment, extra: { nonce: "n1", commitment: H("ff") } }]);
      if (headerOf(init, "PAYMENT-SIGNATURE")) return new Response("ok");
      return challenge([ref, commitment]);
    });
    const s = scheme((a) => a[1]);
    await wrapFetchWithPayment(fetchFn, s)("http://x/a");
    // The commitment entry runs the prepare phase.
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});

describe("sendPayment", () => {
  const payload: PaymentPayload = { x402Version: 2, accepted: ref, payload: { mode: "ref", txHash: H("cc") } };

  it("resends the same payload while the server says retryable, then stops", async () => {
    let calls = 0;
    const seen: string[] = [];
    const fetchFn = jest.fn().mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(headerOf(init, "PAYMENT-SIGNATURE") ?? "");
      calls++;
      return calls < 3 ? challenge([ref], { retryable: true }) : new Response("ok");
    });
    const res = await sendPayment(fetchFn, "http://x/a", undefined, payload, { attempts: 5, delayMs: 1 });
    expect(res.status).toBe(200);
    expect(new Set(seen).size).toBe(1);
    expect(decode({ headers: { "PAYMENT-SIGNATURE": seen[0] ?? "" } }).payload.txHash).toBe(H("cc"));
  });

  it("does not resend after a final refusal", async () => {
    const fetchFn = jest.fn().mockImplementation(async () => challenge([ref], { error: "payment already used" }));
    const res = await sendPayment(fetchFn, "http://x/a", undefined, payload, { attempts: 5, delayMs: 1 });
    expect(res.status).toBe(402);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
