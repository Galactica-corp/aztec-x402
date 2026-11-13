/**
 * The agent's ref and split payments against the real middleware and
 * facilitator scheme, with the chain replaced by mocks: what is stored when,
 * what is sent again, and what is refused.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr } from "@aztec-labs/aztec.js/fields";
import * as sdk from "@galactica-net/inference-money-core";
import { TESTNET_MANIFEST } from "@galactica-net/inference-money-core/deployments";
import type { FacilitatorAztecSigner, ModeVerification, RefPaymentProof, SplitTerms } from "@galactica-net/x402-core";
import { ExactAztecFacilitatorScheme } from "@galactica-net/x402-mechanism";
import { createPaymentMiddleware, memoryStateStore, type MiddlewareResponse } from "@galactica-net/x402-middleware";
import { decodeFunctionData } from "viem";
import * as realSession from "../aztec/session.js";

const USDC = TESTNET_MANIFEST.l2.token.address;
const MERCHANT = "0x09ee8a90f9c3d7db87b55fb92a3bbfc69e65be5b8d4d135c756ecbfec37a1c01";
const AGENT = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const H = (b: string): `0x${string}` => `0x${b.repeat(32)}`;
const manifest = sdk.parseManifest(TESTNET_MANIFEST);

// ---------------------------------------------------------------------------
// A merchant: the real middleware on a local port, its facilitator's chain side mocked.

let verdict: () => Promise<ModeVerification> = async () => ({ isValid: true, amountFound: 10_000n });
let splitTerms: () => Promise<SplitTerms | undefined> = async () => undefined;
const receiveRefPayment = mock(async () => verdict());
const signer: FacilitatorAztecSigner = {
  getAddresses: async () => [MERCHANT],
  prepareCommitment: async () => H("ff"),
  verifyPayment: async () => ({ isValid: true, amountFound: 10_000n }),
  paymentModes: async (_a, wanted) => wanted,
  receiveRefPayment,
  splitTerms: () => splitTerms(),
  verifySplitDeposit: async () => ({ isValid: false, reason: "not-found" }),
};
const store = memoryStateStore();
const middleware = createPaymentMiddleware(
  {
    "/paid": { network: "aztec:testnet", asset: USDC, amount: "10000", payTo: MERCHANT, maxTimeoutSeconds: 60, modes: ["ref", "split", "commitment"] },
  },
  { facilitator: new ExactAztecFacilitatorScheme(signer, ["aztec:testnet"]), store, secret: new Uint8Array(32).fill(3) },
);

let up = true;
/** The merchant serves, then its response is lost on the way (a proxy error stands in for the dropped connection). */
let loseResponse = false;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (!up) return new Response("down", { status: 503 });
    const response = await handle(req);
    return loseResponse && response.ok ? new Response("bad gateway", { status: 502 }) : response;
  },
});

function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  return new Promise<Response>((resolve) => {
    let status = 200;
    const headers: Record<string, string> = {};
    const res: MiddlewareResponse = {
      statusCode: 200,
      status(code) {
        status = code;
        return res;
      },
      setHeader(k, v) {
        headers[k] = v;
        return res;
      },
      json(d) {
        resolve(new Response(JSON.stringify(d), { status, headers: { ...headers, "content-type": "application/json" } }));
        return res;
      },
      end() {
        resolve(new Response(null, { status, headers }));
        return res;
      },
    };
    const h: Record<string, string> = {};
    req.headers.forEach((v, k) => (h[k] = v));
    void middleware({ path: url.pathname, method: req.method, url: req.url, headers: h }, res, () =>
      resolve(new Response(JSON.stringify({ secret: "the content" }), { headers: { ...headers, "content-type": "application/json" } })),
    );
  });
}
const URL_PAID = `http://127.0.0.1:${server.port}/paid`;

// ---------------------------------------------------------------------------
// The agent: its wallet session mocked, everything else real.

const payPrivate = mock(
  async (_payTo: AztecAddress, _amount: bigint, paymentRef: string): Promise<RefPaymentProof> => ({
    txHash: H("cc"),
    paymentRef,
    messages: [{ recipient: MERCHANT, contractAddress: USDC, ciphertext: ["0x1"], anchorBlockTimestamp: "1" }],
  }),
);
const adapter = { kind: "inference-money", preflight: async () => {}, payPrivate };
mock.module("../aztec/session.js", () => ({
  ...realSession,
  openSession: async () => ({
    account: { address: AztecAddress.fromStringUnsafe(AGENT) },
    tokens: { get: async () => adapter },
  }),
  tokenAt: async () => adapter,
}));

// `fund change`: the SDK's chain calls replaced while `changeFake` is set, the real SDK otherwise.
const realSdk = { ...sdk };
let changeFake: { state: "unclaimed" | "owed" | "settled" } | undefined;
const fakeChange = { amount: 990_000n, buyer: AztecAddress.fromStringUnsafe(AGENT), changeSalt: Fr.ONE, claim: { fake: true } };
const sdkClaimSplit = mock(async (): Promise<sdk.ClaimResult> => "claimed");
const sdkWaitClaimable = mock(async () => {});
const sdkClaimChange = mock(async () => ({ toString: () => H("d1") }));
const faked =
  <A extends unknown[], R>(real: (...a: A) => R, fake: (...a: A) => unknown) =>
  (...a: A) =>
    changeFake ? fake(...a) : real(...a);
mock.module("@galactica-net/inference-money-core", () => ({
  ...realSdk,
  decodeClaimTicket: faked(realSdk.decodeClaimTicket, () => ({ fake: true })),
  changeOf: faked(realSdk.changeOf, () => fakeChange),
  changeState: faked(realSdk.changeState, async () => changeFake?.state),
  waitSplitClaimable: faked(realSdk.waitSplitClaimable, sdkWaitClaimable),
  claimSplit: faked(realSdk.claimSplit, sdkClaimSplit),
  claimChange: faked(realSdk.claimChange, sdkClaimChange),
  registerSponsor: faked(realSdk.registerSponsor, async () => {}),
  registerBridgeContracts: faked(realSdk.registerBridgeContracts, async () => {}),
}));

let home: string;
let previousHome: string | undefined;
beforeAll(() => {
  previousHome = process.env.AZTEC_X402_HOME;
  home = mkdtempSync(join(tmpdir(), "x402-pay-"));
  process.env.AZTEC_X402_HOME = home;
});
afterAll(() => {
  server.stop(true);
  if (previousHome === undefined) delete process.env.AZTEC_X402_HOME;
  else process.env.AZTEC_X402_HOME = previousHome;
});
afterEach(() => {
  verdict = async () => ({ isValid: true, amountFound: 10_000n });
  splitTerms = async () => undefined;
  up = true;
  loseResponse = false;
  changeFake = undefined;
});

async function cli(argv: string[]): Promise<{ code: number; out: Record<string, unknown> }> {
  const { main } = await import("../main.js");
  const chunks: string[] = [];
  const spy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    const code = await main([...argv, "--quiet", "--network", "testnet"]);
    return { code, out: JSON.parse(chunks.join("")) };
  } finally {
    spy.mockRestore();
  }
}

const proofFile = (id: string) => join(home, "testnet", "proofs", `${id}.json`);
const field = (o: Record<string, unknown>, ...path: string[]): unknown =>
  path.reduce<unknown>((v, k) => (typeof v === "object" && v !== null ? Reflect.get(v, k) : undefined), o);

describe("pay (ref)", () => {
  test("pays privately under the merchant's reference, stores the proof, and is served", async () => {
    const before = payPrivate.mock.calls.length;
    const { code, out } = await cli(["pay", URL_PAID, "--max-amount", "0.02"]);
    expect(code).toBe(0);
    expect(field(out, "body", "secret")).toBe("the content");
    expect(field(out, "payment", "mode")).toBe("ref");
    expect(payPrivate.mock.calls.length).toBe(before + 1);
    const id = String(field(out, "payment", "id"));
    const stored = JSON.parse(readFileSync(proofFile(id), "utf-8"));
    expect(stored.acknowledgedAt).toBeDefined();
    expect(stored.payload.payload.mode).toBe("ref");
    const ledger = readFileSync(join(home, "testnet", "payments.jsonl"), "utf-8");
    expect(ledger).toContain('"mode":"ref"');
  });

  test("keeps the proof when the merchant refuses it, and --resume delivers the same proof once", async () => {
    verdict = async () => ({ isValid: false, reason: "no-payment", error: "not yet in the wallet" });
    const before = payPrivate.mock.calls.length;
    const failed = await cli(["pay", URL_PAID, "--max-amount", "0.02"]);
    expect(failed.code).toBe(1);
    expect(field(failed.out, "error", "code")).toBe("not_delivered");
    const resume = String(field(failed.out, "error", "resume"));
    const id = resume.split(" ").pop() ?? "";
    const stored = JSON.parse(readFileSync(proofFile(id), "utf-8"));
    expect(stored.acknowledgedAt).toBeUndefined();

    verdict = async () => ({ isValid: true, amountFound: 10_000n });
    const delivered = await cli(["pay", "--resume", id]);
    expect(delivered.code).toBe(0);
    expect(field(delivered.out, "body", "secret")).toBe("the content");
    // Paid once, delivered twice with the same proof.
    expect(payPrivate.mock.calls.length).toBe(before + 1);

    const again = await cli(["pay", "--resume", id]);
    expect(field(again.out, "error", "code")).toBe("already_delivered");
  });

  test("survives a merchant that is down after the payment: the stored proof is delivered later", async () => {
    payPrivate.mockImplementationOnce(async (_p, _a, paymentRef) => {
      up = false;
      return { txHash: H("cd"), paymentRef, messages: [{ recipient: MERCHANT, contractAddress: USDC, ciphertext: ["0x2"], anchorBlockTimestamp: "1" }] };
    });
    const failed = await cli(["pay", URL_PAID, "--max-amount", "0.02"]);
    expect(field(failed.out, "error", "code")).toBe("not_delivered");
    const id = String(field(failed.out, "error", "payment", "id"));
    expect(existsSync(proofFile(id))).toBe(true);
    up = true;
    expect((await cli(["pay", "--resume", id])).code).toBe(0);
  });
});

describe("a response lost after the merchant served", () => {
  test("cannot be delivered again: the payment is closed as response_lost, without resume", async () => {
    loseResponse = true;
    const before = payPrivate.mock.calls.length;
    const failed = await cli(["pay", URL_PAID, "--max-amount", "0.02"]);
    expect(field(failed.out, "error", "code")).toBe("not_delivered");
    const id = String(field(failed.out, "error", "payment", "id"));
    loseResponse = false;

    // The merchant refuses the same payment: it was served once.
    const resumed = await cli(["pay", "--resume", id]);
    expect(resumed.code).toBe(1);
    expect(field(resumed.out, "error", "code")).toBe("response_lost");
    expect(field(resumed.out, "error", "resume")).toBeUndefined();
    expect(JSON.parse(readFileSync(proofFile(id), "utf-8")).responseLostAt).toBeDefined();

    // Asking again answers from the stored state, and nothing was paid twice.
    const again = await cli(["pay", "--resume", id]);
    expect(field(again.out, "error", "code")).toBe("response_lost");
    expect(payPrivate.mock.calls.length).toBe(before + 1);
  });
});

describe("a payment whose reference another payment was served for", () => {
  test("is closed as payment_superseded, not response_lost, without resume", async () => {
    payPrivate.mockImplementationOnce(async (_p, _a, paymentRef) => {
      // Someone else who saw the 402 paid under its reference first, and was served.
      await store.markServed(paymentRef, "another", { payment: H("ee") });
      return { txHash: H("ce"), paymentRef, messages: [{ recipient: MERCHANT, contractAddress: USDC, ciphertext: ["0x3"], anchorBlockTimestamp: "1" }] };
    });
    const failed = await cli(["pay", URL_PAID, "--max-amount", "0.02"]);
    expect(failed.code).toBe(1);
    expect(field(failed.out, "error", "code")).toBe("payment_superseded");
    expect(field(failed.out, "error", "resume")).toBeUndefined();
    const id = String(field(failed.out, "error", "payment", "id"));
    expect(JSON.parse(readFileSync(proofFile(id), "utf-8")).supersededAt).toBeDefined();

    const again = await cli(["pay", "--resume", id]);
    expect(field(again.out, "error", "code")).toBe("payment_superseded");
  });
});

describe("fund change", () => {
  const record = (id: string, status: string, ageMs = 0) => ({
    id,
    createdAt: new Date(Date.now() - ageMs).toISOString(),
    url: URL_PAID,
    request: { method: "GET", headers: {} },
    accepted: {},
    price: "10000",
    amount: "1000000",
    draft: "unused",
    l1FromBlock: "0",
    ticket: "fake",
    status,
  });
  const writeRecords = (...records: object[]) => {
    mkdirSync(join(home, "testnet"), { recursive: true });
    writeFileSync(join(home, "testnet", "split-payments.json"), JSON.stringify(records), { mode: 0o600 });
  };

  test("claims a superseded deposit itself, since its merchant will not, then collects the change", async () => {
    changeFake = { state: "unclaimed" };
    writeRecords(record("superseded-1", "superseded"), record("waiting-1", "not_served"));
    const claims = sdkClaimSplit.mock.calls.length;
    const { code, out } = await cli(["fund", "change", "--allow-bind"]);
    expect(code).toBe(0);
    expect(sdkClaimSplit.mock.calls.length).toBe(claims + 1);
    // From the agent's own account: the price still goes to the merchant, the change is released to the agent.
    expect(sdkClaimSplit.mock.calls.at(-1)).toMatchObject([{ fake: true }, {}, undefined, {}, { from: fakeChange.buyer }]);
    expect(field(out, "collected")).toMatchObject([{ id: "superseded-1", amount: "0.99" }]);
    // A deposit the merchant may still claim is left to it.
    expect(field(out, "waiting")).toMatchObject([{ id: "waiting-1" }]);
  });

  test("claims a deposit its merchant left unclaimed past the 24 h grace, whatever the payment's status, then collects the change", async () => {
    const { SELF_CLAIM_AFTER_MS } = await import("../commands/pay-split.js");
    changeFake = { state: "unclaimed" };
    const overdue = SELF_CLAIM_AFTER_MS + 60_000;
    writeRecords(
      record("never-served", "not_served", overdue),
      record("served-lost", "served", overdue),
      record("fresh", "not_served", SELF_CLAIM_AFTER_MS - 60 * 60_000),
    );
    const claims = sdkClaimSplit.mock.calls.length;
    const { code, out } = await cli(["fund", "change", "--allow-bind"]);
    expect(code).toBe(0);
    expect(sdkClaimSplit.mock.calls.length).toBe(claims + 2);
    expect(sdkClaimSplit.mock.calls.at(-1)).toMatchObject([{ fake: true }, {}, undefined, {}, { from: fakeChange.buyer }]);
    expect(field(out, "collected")).toMatchObject([{ id: "never-served" }, { id: "served-lost" }]);
    // Within the grace the merchant may still claim: left to it, saying when the agent steps in.
    expect(field(out, "waiting")).toMatchObject([{ id: "fresh" }]);
    const after = Date.parse(String(field(out, "waiting", "0", "selfClaimAfter")));
    expect(after - Date.now()).toBeGreaterThan(50 * 60_000);
    expect(after - Date.now()).toBeLessThan(70 * 60_000);
  });

  test("still collects the change when the merchant claimed first, racing the agent's own claim", async () => {
    const { SELF_CLAIM_AFTER_MS } = await import("../commands/pay-split.js");
    changeFake = { state: "unclaimed" };
    writeRecords(record("raced", "not_served", SELF_CLAIM_AFTER_MS + 60_000));
    sdkClaimSplit.mockImplementationOnce(async () => "consumed-unknown");
    const changes = sdkClaimChange.mock.calls.length;
    const { code, out } = await cli(["fund", "change", "--allow-bind"]);
    expect(code).toBe(0);
    expect(sdkClaimChange.mock.calls.length).toBe(changes + 1);
    expect(field(out, "collected")).toMatchObject([{ id: "raced", amount: "0.99" }]);
  });

  test("waits while a superseded deposit is not claimable on Aztec yet", async () => {
    changeFake = { state: "unclaimed" };
    writeRecords(record("superseded-2", "superseded"));
    sdkWaitClaimable.mockImplementationOnce(async () => {
      throw Object.create(realSdk.MessageNotConsumableError.prototype);
    });
    const claims = sdkClaimSplit.mock.calls.length;
    const { out } = await cli(["fund", "change", "--allow-bind"]);
    expect(sdkClaimSplit.mock.calls.length).toBe(claims);
    expect(field(out, "waiting")).toMatchObject([{ id: "superseded-2" }]);
  });
});

describe("pay --from-ethereum", () => {
  const terms = (over: Partial<SplitTerms> = {}): SplitTerms => ({
    merchant: MERCHANT,
    price: "10000",
    denominations: ["1000000", "5000000"],
    chainId: manifest.l1.chainId,
    portal: manifest.l1.portal,
    ...over,
  });

  test("refuses split terms for another bridge before anything is signed", async () => {
    splitTerms = async () => terms({ portal: "0x" + "66".repeat(20) });
    const { out } = await cli(["pay", URL_PAID, "--max-amount", "0.02", "--from-ethereum", "--hosted", "--no-wait"]);
    expect(field(out, "error", "code")).toBe("split_terms_mismatch");
  });

  test("refuses when the merchant offers no payment from Ethereum", async () => {
    const { out } = await cli(["pay", URL_PAID, "--max-amount", "0.02", "--from-ethereum"]);
    expect(field(out, "error", "code")).toBe("no_split_option");
  });
});

describe("split deposit plan", () => {
  test("approves Permit2 once, signs the permit, sends the deposit with the signature filled in", async () => {
    const { buildSplitPlan, chooseDeposit, typedDataForWallet } = await import("../fund/split.js");
    const merchant = AztecAddress.fromStringUnsafe(MERCHANT);
    const entry = { off: false, scheduledOff: false, changeAt: 0n, delay: undefined, scheduledDelay: undefined, delayChangeAt: 0n };
    const list: sdk.MerchantList = { block: 1, at: 1_000n, entries: new Map([[merchant.toString(), entry]]) };
    const draft = await sdk.prepareSplitDeposit(
      { amount: 1_000_000n, merchant, price: 10_000n, paymentRef: new Fr(9n), buyer: AztecAddress.fromStringUnsafe(AGENT) },
      manifest,
      () => 1_000n,
      list,
    );
    const { NETWORKS } = await import("../networks.js");
    const network = NETWORKS.testnet;
    if (!network) throw new Error("no testnet");
    const plan = buildSplitPlan(network, manifest, draft, AGENT, MERCHANT, "10000", (v) => v.toString());
    expect(plan.kind).toBe("split");
    expect(plan.steps.map((s) => s.id)).toEqual(["approve", "permit", "deposit"]);
    const [approve, permit, deposit] = plan.steps;
    expect(approve?.skipIf?.data).toContain("{owner}");
    expect(approve?.skipIf?.gte).toBe("1000000");
    expect(permit?.kind).toBe("sign");
    expect(deposit?.to.toLowerCase()).toBe(manifest.l1.router.toLowerCase());
    expect(deposit?.data.split("{signature}")).toHaveLength(2);

    const signature = `0x${"ab".repeat(64)}1b`;
    const filled = (deposit?.data ?? "").replace("{signature}", signature.slice(2));
    const decoded = decodeFunctionData({ abi: sdk.PERMIT2_DEPOSIT_ROUTER_ABI, data: `0x${filled.slice(2)}` });
    expect(decoded.args?.[0]).toBe(1_000_000n);
    expect(decoded.args?.[2]).toBe(draft.witness.secretHash);
    expect(decoded.args?.[3]).toBe(true);
    expect(decoded.args?.[6]).toBe(signature);

    const td = typedDataForWallet(draft);
    expect(field({ td }, "td", "types", "EIP712Domain")).toBeDefined();
    expect(typeof field({ td }, "td", "message", "nonce")).toBe("string");

    const t = { merchant: MERCHANT, price: "10000", denominations: ["5000000", "1000000"], chainId: 1, portal: "0x" + "00".repeat(20) };
    expect(chooseDeposit(t)).toBe(1_000_000n);
    expect(chooseDeposit(t, 5_000_000n)).toBe(5_000_000n);
    expect(() => chooseDeposit(t, 10_000n)).toThrow("not offered");
  });
});
