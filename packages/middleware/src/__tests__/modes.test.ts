import { afterEach, describe, expect, it, jest } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";
import type { FacilitatorAztecSigner, ModeVerification, PaymentStateStore, RefPaymentProof } from "@galactica-net/x402-core";
import { ExactAztecFacilitatorScheme } from "@galactica-net/x402-mechanism/exact/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@galactica-net/x402-mechanism";
import { createPaymentMiddleware } from "../middleware.js";
import { derivePaymentRef } from "../reference.js";
import { memoryStateStore } from "../store/memory.js";
import { sqliteStateStore } from "../store/sqlite.js";
import type { MiddlewareResponse, RouteConfig } from "../types.js";

const H = (b: string) => "0x" + b.repeat(32);
const TOKEN = H("dd");
const MERCHANT = H("bb");
const PRICE = "10000";
const PORTAL = "0x" + "ab".repeat(20);
const SECRET = new Uint8Array(32).fill(7);
const PATH = "/paid";

const route = (over: Partial<RouteConfig> = {}): RouteConfig => ({
  network: "aztec:sandbox",
  asset: TOKEN,
  amount: PRICE,
  payTo: MERCHANT,
  maxTimeoutSeconds: 120,
  modes: ["ref", "split", "commitment"],
  ...over,
});

const ok = (over: Partial<ModeVerification> = {}): ModeVerification => ({ isValid: true, amountFound: 10_000n, ...over });

function signer(over: Partial<FacilitatorAztecSigner> = {}): FacilitatorAztecSigner {
  return {
    getAddresses: async () => [MERCHANT],
    prepareCommitment: async () => H("ff"),
    verifyPayment: async () => ({ isValid: true, amountFound: 10_000n }),
    paymentModes: async (_a, wanted) => wanted,
    splitTerms: async () => ({ merchant: MERCHANT, price: PRICE, denominations: ["1000000"], chainId: 31337, portal: PORTAL }),
    receiveRefPayment: jest.fn(async () => ok()),
    verifySplitDeposit: jest.fn(async () => ok({ splitClaim: '{"claim":1}' })),
    ...over,
  };
}

interface Res extends MiddlewareResponse {
  headers: Record<string, string>;
  body: unknown;
}

function res(): Res {
  const r: Res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      r.statusCode = code;
      return r;
    },
    setHeader(k, v) {
      r.headers[k] = v;
      return r;
    },
    json(d) {
      r.body = d;
      return r;
    },
    end() {
      return r;
    },
  };
  return r;
}

type Middleware = ReturnType<typeof createPaymentMiddleware>;

function setup(opts: { signer?: FacilitatorAztecSigner; store?: PaymentStateStore; route?: RouteConfig } = {}) {
  const s = opts.signer ?? signer();
  const store = opts.store ?? memoryStateStore();
  const facilitator = new ExactAztecFacilitatorScheme(s, ["aztec:sandbox"]);
  const mw = createPaymentMiddleware({ [PATH]: opts.route ?? route() }, { facilitator, store, secret: SECRET });
  return { mw, signer: s, store };
}

async function call(mw: Middleware, headers: Record<string, string> = {}) {
  const r = res();
  const next = jest.fn();
  await mw({ path: PATH, method: "GET", url: PATH, headers }, r, next);
  const header = r.headers["PAYMENT-REQUIRED"];
  const challenge = header ? JSON.parse(Buffer.from(header, "base64").toString()) : undefined;
  return { res: r, served: next.mock.calls.length > 0, challenge };
}

async function offer(mw: Middleware, mode: "ref" | "split"): Promise<PaymentRequirements> {
  const { challenge } = await call(mw);
  return challenge.accepts.find((a: PaymentRequirements) => a.extra.mode === mode);
}

const refProof = (paymentRef: string, over: Record<string, unknown> = {}) => ({
  mode: "ref",
  txHash: H("cc"),
  paymentRef,
  messages: [0, 1].map((i) => ({ recipient: MERCHANT, contractAddress: TOKEN, ciphertext: [`0x${i + 1}`], anchorBlockTimestamp: "1" })),
  ...over,
});

const splitProof = (paymentRef: string, over: Record<string, unknown> = {}) => ({
  mode: "split",
  l1TxHash: H("ee"),
  price: PRICE,
  paymentRef,
  changeCommitment: H("1a"),
  salt: H("2b"),
  ...over,
});

function refOf(r: PaymentRequirements): string {
  const ref = r.extra.paymentRef;
  if (typeof ref !== "string") throw new Error("no paymentRef in this offer");
  return ref;
}

const header = (accepted: PaymentRequirements, payload: Record<string, unknown>) => ({
  "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload } satisfies PaymentPayload)).toString("base64"),
});

const pay = (mw: Middleware, accepted: PaymentRequirements, payload: Record<string, unknown>) => call(mw, header(accepted, payload));

describe("the 402", () => {
  it("offers ref, split and commitment in route order, sharing a nonce and a derived reference", async () => {
    const { mw } = setup();
    const { challenge } = await call(mw);
    const [ref, split, commitment] = challenge.accepts;
    expect(challenge.accepts.map((a: PaymentRequirements) => a.extra.mode)).toEqual(["ref", "split", "commitment"]);
    expect(new Set(challenge.accepts.map((a: PaymentRequirements) => a.extra.nonce)).size).toBe(1);
    expect(split.extra.paymentRef).toBe(ref.extra.paymentRef);
    expect(commitment.extra.paymentRef).toBeUndefined();
    const nonce = ref.extra.nonce;
    expect(ref.extra.paymentRef).toBe(
      derivePaymentRef(SECRET, { nonce, network: "aztec:sandbox", asset: TOKEN, payTo: MERCHANT, price: PRICE }),
    );
    expect(split.extra).toMatchObject({ portal: PORTAL, price: PRICE, merchant: MERCHANT });
  });

  it("falls back to the commitment flow alone when the facilitator cannot be asked", async () => {
    const { mw } = setup({ signer: signer({ paymentModes: async () => Promise.reject(new Error("node down")) }) });
    const { challenge } = await call(mw);
    expect(challenge.accepts).toHaveLength(1);
    expect(challenge.accepts[0].extra.mode).toBeUndefined();
  });

  it("refuses to start without a store or a secret when a route offers ref or split", () => {
    const facilitator = new ExactAztecFacilitatorScheme(signer(), ["aztec:sandbox"]);
    expect(() => createPaymentMiddleware({ [PATH]: route() }, { facilitator })).toThrow("store");
    expect(() => createPaymentMiddleware({ [PATH]: route() }, { facilitator, store: memoryStateStore() })).toThrow("secret");
    expect(() =>
      createPaymentMiddleware({ [PATH]: route() }, { facilitator, store: memoryStateStore(), secret: new Uint8Array(8) }),
    ).toThrow("32");
  });
});

describe("ref payments", () => {
  it("are stored before verification, verified and served once; a retried request is refused", async () => {
    const order: string[] = [];
    const store = memoryStateStore();
    const saveProof = store.saveProof.bind(store);
    store.saveProof = async (p) => (order.push("store"), saveProof(p));
    const s = signer({ receiveRefPayment: jest.fn(async () => (order.push("verify"), ok())) });
    const { mw } = setup({ signer: s, store });
    const accepted = await offer(mw, "ref");
    const proof = refProof(refOf(accepted));

    const first = await pay(mw, accepted, proof);
    expect(first.served).toBe(true);
    expect(first.res.headers["PAYMENT-RESPONSE"]).toBeDefined();
    expect(order).toEqual(["store", "verify"]);
    expect(await store.proofsNotTakenIn(0)).toHaveLength(0);

    const again = await pay(mw, accepted, proof);
    expect(again.served).toBe(false);
    expect(again.challenge.error).toBe("payment already used");
    expect(s.receiveRefPayment).toHaveBeenCalledTimes(1);
  });

  it("refuse a proof replayed for another nonce, and a price lowered by the client", async () => {
    const { mw, signer: s } = setup();
    const a = await offer(mw, "ref");
    const b = await offer(mw, "ref");
    const proofA = refProof(refOf(a));

    const replay = await pay(mw, { ...b, extra: { ...b.extra, paymentRef: a.extra.paymentRef } }, proofA);
    expect(replay.challenge.error).toBe("invalid payment reference");

    const cheaper = await pay(mw, { ...a, amount: "1" }, proofA);
    expect(cheaper.challenge.error).toBe("invalid payment reference");
    expect(s.receiveRefPayment).not.toHaveBeenCalled();
  });

  it("refuse a proof whose messages are for another merchant, without storing it", async () => {
    const store = memoryStateStore();
    const { mw } = setup({ store });
    const accepted = await offer(mw, "ref");
    const proof = refProof(refOf(accepted));
    proof.messages = [{ ...proof.messages[0], recipient: H("aa") }];
    const result = await pay(mw, accepted, proof);
    expect(result.challenge.error).toContain("another account");
    expect(await store.proofsNotTakenIn(0)).toHaveLength(0);
  });

  it("answer a not-yet-mined proof with a retryable 402 and keep it; the same proof then serves", async () => {
    const receive = jest.fn(async () => ok({ isValid: false, reason: "not-mined", retryable: true }));
    const store = memoryStateStore();
    const { mw } = setup({ signer: signer({ receiveRefPayment: receive }), store });
    const accepted = await offer(mw, "ref");
    const proof = refProof(refOf(accepted));

    const pending = await pay(mw, accepted, proof);
    expect(pending.served).toBe(false);
    expect(pending.challenge.retryable).toBe(true);
    expect(pending.challenge.accepts[0].extra.paymentRef).toBe(accepted.extra.paymentRef);
    expect(await store.proofsNotTakenIn(0)).toHaveLength(1);

    receive.mockImplementation(async () => ok());
    expect((await pay(mw, accepted, proof)).served).toBe(true);
  });

  it("tell a payment that lost its reference to another apart from a served one resent", async () => {
    const { mw } = setup();
    const accepted = await offer(mw, "ref");
    const proof = refProof(refOf(accepted));
    expect((await pay(mw, accepted, proof)).served).toBe(true);

    const resent = await pay(mw, accepted, { ...proof, txHash: proof.txHash.toUpperCase().replace("0X", "0x") });
    expect(resent.challenge.error).toBe("payment already used");
    const other = await pay(mw, accepted, refProof(refOf(accepted), { txHash: H("c1") }));
    expect(other.served).toBe(false);
    expect(other.challenge.error).toBe("another payment under this reference was served");
  });

  it("serve exactly one of two concurrent requests with the same proof", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { mw } = setup({ signer: signer({ receiveRefPayment: jest.fn(async () => (await gate, ok())) }) });
    const accepted = await offer(mw, "ref");
    const proof = refProof(refOf(accepted));
    const both = [pay(mw, accepted, proof), pay(mw, accepted, proof)];
    await new Promise((r) => setTimeout(r, 10));
    release();
    const results = await Promise.all(both);
    expect(results.filter((r) => r.served)).toHaveLength(1);
    expect(results.find((r) => !r.served)?.challenge.retryable).toBe(true);
  });

  it("are taken after the quote expired, within the retention, but not after it", async () => {
    const { mw } = setup();
    const terms = (nonce: string) => ({ nonce, network: "aztec:sandbox", asset: TOKEN, payTo: MERCHANT, price: PRICE });
    const base = await offer(mw, "ref");
    const at = (msecs: number) => {
      const nonce = uuidv7({ msecs });
      const paymentRef = derivePaymentRef(SECRET, terms(nonce));
      return { accepted: { ...base, extra: { nonce, mode: "ref", paymentRef } }, paymentRef };
    };
    const late = at(Date.now() - 10 * 60_000);
    expect((await pay(mw, late.accepted, refProof(late.paymentRef))).served).toBe(true);
    const tooLate = at(Date.now() - 27 * 60 * 60_000);
    expect((await pay(mw, tooLate.accepted, refProof(tooLate.paymentRef))).challenge.error).toBe("invalid or expired payment nonce");
  });

  it("still serve the buyer's proof after junk proofs filled the reference's slots", async () => {
    const valid = H("99");
    const receiveRefPayment = jest.fn(async (_asset: string, proof: RefPaymentProof) =>
      proof.txHash === valid ? ok() : ok({ isValid: false, reason: "no-payment" }),
    );
    const store = memoryStateStore();
    const { mw } = setup({ signer: signer({ receiveRefPayment }), store });
    const accepted = await offer(mw, "ref");
    const ref = refOf(accepted);
    for (let i = 0; i < 12; i++) {
      const junk = await pay(mw, accepted, refProof(ref, { txHash: "0x" + i.toString(16).padStart(64, "0") }));
      expect(junk.served).toBe(false);
    }
    // The store keeps a bounded number; the buyer's proof is verified and served anyway.
    expect((await store.proofsNotTakenIn(0)).length).toBe(8);
    expect((await pay(mw, accepted, refProof(ref, { txHash: valid }))).served).toBe(true);
  });

  it("do not make the buyer's proof wait on another proof's verification", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const valid = H("99");
    const receiveRefPayment = jest.fn(async (_asset: string, proof: RefPaymentProof) =>
      proof.txHash === valid ? ok() : (await gate, ok({ isValid: false, reason: "no-payment" })),
    );
    const { mw } = setup({ signer: signer({ receiveRefPayment }) });
    const accepted = await offer(mw, "ref");
    const ref = refOf(accepted);
    const junk = pay(mw, accepted, refProof(ref, { txHash: H("01") }));
    await new Promise((r) => setTimeout(r, 10));
    expect((await pay(mw, accepted, refProof(ref, { txHash: valid }))).served).toBe(true);
    release();
    expect((await junk).served).toBe(false);
  });

  it("are refused on a route that does not offer them", async () => {
    const { mw } = setup({ route: route({ modes: ["split", "commitment"] }) });
    const accepted = await offer(mw, "split");
    const result = await pay(mw, { ...accepted, extra: { ...accepted.extra, mode: "ref" } }, refProof(refOf(accepted)));
    expect(result.challenge.error).toContain("not offered");
  });
});

describe("split payments", () => {
  it("answer an unconfirmed deposit with a retryable 402, then store the claim and serve", async () => {
    const verify = jest.fn(async () => ok({ isValid: false, reason: "unconfirmed", retryable: true }));
    const store = memoryStateStore();
    const { mw } = setup({ signer: signer({ verifySplitDeposit: verify }), store });
    const accepted = await offer(mw, "split");
    const proof = splitProof(refOf(accepted));

    expect((await pay(mw, accepted, proof)).challenge.retryable).toBe(true);
    verify.mockImplementation(async () => ok({ splitClaim: '{"claim":1}' }));
    expect((await pay(mw, accepted, proof)).served).toBe(true);
    expect(await store.splitClaims("pending")).toMatchObject([{ paymentRef: accepted.extra.paymentRef, claim: '{"claim":1}' }]);
  });

  it("store the claim of the deposit that was served when two valid deposits race", async () => {
    const DEPOSIT_A = H("a1");
    const DEPOSIT_B = H("b2");
    const verify = jest.fn(async (_asset: string, proof: { l1TxHash: string }) => ok({ splitClaim: `{"deposit":"${proof.l1TxHash}"}` }));
    const store = memoryStateStore();
    // A is verified first, but its served mark is held until B's request has finished.
    let bDone!: () => void;
    const bFinished = new Promise<void>((r) => (bDone = r));
    const markServed = store.markServed.bind(store);
    let first = true;
    store.markServed = async (...args) => {
      if (first) {
        first = false;
        await bFinished;
      }
      return markServed(...args);
    };
    const { mw } = setup({ signer: signer({ verifySplitDeposit: verify }), store });
    const accepted = await offer(mw, "split");

    const a = pay(mw, accepted, splitProof(refOf(accepted), { l1TxHash: DEPOSIT_A }));
    await new Promise((r) => setTimeout(r, 10));
    const b = await pay(mw, accepted, splitProof(refOf(accepted), { l1TxHash: DEPOSIT_B, salt: H("3c") }));
    bDone();
    const lost = await a;

    expect(b.served).toBe(true);
    expect(lost.served).toBe(false);
    expect(lost.challenge.error).toBe("another payment under this reference was served");
    expect(await store.splitClaims()).toMatchObject([{ claim: `{"deposit":"${DEPOSIT_B}"}` }]);
  });

  it("refuse a deposit proof for another price", async () => {
    const { mw, signer: s } = setup();
    const accepted = await offer(mw, "split");
    const result = await pay(mw, accepted, splitProof(refOf(accepted), { price: "1" }));
    expect(result.served).toBe(false);
    expect(s.verifySplitDeposit).not.toHaveBeenCalled();
  });
});

describe("the commitment flow on a route with modes", () => {
  it("still prepares and verifies for a client that ignores extra.mode", async () => {
    const { mw } = setup();
    const { challenge } = await call(mw);
    const nonce = challenge.accepts[0].extra.nonce;
    const prepare = Buffer.from(JSON.stringify({ nonce, senderAddress: H("aa") })).toString("base64");
    const prepared = await call(mw, { "x-402-prepare": prepare });
    const accepted = prepared.challenge.accepts[0];
    expect(accepted.extra.commitment).toBe(H("ff"));
    const payload = { senderAddress: H("aa"), correlationId: "c", txHash: H("cc"), timestamp: new Date().toISOString() };
    expect((await pay(mw, accepted, payload)).served).toBe(true);
  });
});

describe("a route that does not list commitment", () => {
  const commitmentPayload = { senderAddress: H("aa"), correlationId: "c", txHash: H("cc"), timestamp: new Date().toISOString() };
  const noCommitment = (modes: RouteConfig["modes"]) => route({ modes });

  it("offers no commitment when the facilitator has none of the listed modes now", async () => {
    for (const modes of [["ref"], ["ref", "split"]] as const) {
      const { mw } = setup({ route: noCommitment([...modes]), signer: signer({ paymentModes: async () => [] }) });
      const { challenge } = await call(mw);
      expect(challenge.accepts).toEqual([]);
      expect(challenge.error).toContain("no payment method");
    }
  });

  it("offers no commitment when the facilitator cannot be asked", async () => {
    const { mw } = setup({
      route: noCommitment(["ref", "split"]),
      signer: signer({ paymentModes: async () => Promise.reject(new Error("node down")) }),
    });
    expect((await call(mw)).challenge.accepts).toEqual([]);
  });

  it("offers only the listed modes the facilitator has", async () => {
    const { mw } = setup({ route: noCommitment(["ref", "split"]), signer: signer({ splitTerms: async () => undefined }) });
    const { challenge } = await call(mw);
    expect(challenge.accepts.map((a: PaymentRequirements) => a.extra.mode)).toEqual(["ref"]);
  });

  it("refuses a commitment prepare and payment for a nonce it issued", async () => {
    const prepareCommitment = jest.fn(async () => H("ff"));
    const verifyPayment = jest.fn(async () => ({ isValid: true, amountFound: 10_000n }));
    const { mw } = setup({ route: noCommitment(["ref"]), signer: signer({ prepareCommitment, verifyPayment }) });
    const nonce = (await call(mw)).challenge.accepts[0].extra.nonce;

    const prepare = Buffer.from(JSON.stringify({ nonce, senderAddress: H("aa") })).toString("base64");
    const prepared = await call(mw, { "x-402-prepare": prepare });
    expect(prepared.challenge.error).toBe('payment mode "commitment" is not offered for this resource');

    const { modes: _modes, ...terms } = route();
    const accepted: PaymentRequirements = { ...terms, scheme: "exact", extra: { nonce, commitment: H("ff") } };
    const paid = await pay(mw, accepted, commitmentPayload);
    expect(paid.served).toBe(false);
    expect(paid.challenge.error).toBe('payment mode "commitment" is not offered for this resource');
    expect(prepareCommitment).not.toHaveBeenCalled();
    expect(verifyPayment).not.toHaveBeenCalled();
  });
});

describe("across restarts (SQLite)", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("a second server on the same file sees the served reference and the pending proofs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-mw-"));
    dirs.push(dir);
    const file = join(dir, "state.sqlite");
    const receive = jest.fn(async () => ok({ isValid: false, reason: "not-mined", retryable: true }));
    const first = setup({ signer: signer({ receiveRefPayment: receive }), store: sqliteStateStore(file) });
    const accepted = await offer(first.mw, "ref");
    const proof = refProof(refOf(accepted));
    await pay(first.mw, accepted, proof);
    first.store.close?.();

    const second = setup({ store: sqliteStateStore(file) });
    expect(await second.store.proofsNotTakenIn(0)).toHaveLength(1);
    expect((await pay(second.mw, accepted, proof)).served).toBe(true);
    second.store.close?.();

    const third = setup({ store: sqliteStateStore(file) });
    expect((await pay(third.mw, accepted, proof)).challenge.error).toBe("payment already used");
    third.store.close?.();
  });
});
