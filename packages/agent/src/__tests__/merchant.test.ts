import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract";
import * as sdk from "@galactica-net/inference-money-core";
import type { PaymentStateStore, StoredSplitClaim } from "@galactica-net/x402-core";
import { memoryStateStore, sqliteStateStore } from "@galactica-net/x402-middleware";
import { MerchantJobs, type SplitClaimer } from "../aztec/merchant-jobs.js";
import { parseSplitClaim, serializeSplitClaim } from "../aztec/split-merchant.js";
import type { TokenContext } from "../aztec/tokens/adapter.js";
import { TokenRegistry } from "../aztec/tokens/registry.js";

const INFERENCE = "0x0a" + "b2".repeat(31);
const MERCHANT = AztecAddress.fromStringUnsafe("0x09ee8a90f9c3d7db87b55fb92a3bbfc69e65be5b8d4d135c756ecbfec37a1c01");
const USER = AztecAddress.fromStringUnsafe("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
const REF = "0x" + "0f".repeat(32);
const H = (b: string): `0x${string}` => `0x${b.repeat(32)}`;
const inferenceClassId = (await getContractClassFromArtifact(sdk.tokenArtifact)).id;

const proof = {
  txHash: H("cc"),
  paymentRef: REF,
  messages: [{ recipient: MERCHANT.toString(), contractAddress: INFERENCE, ciphertext: ["0x1"], anchorBlockTimestamp: "1" }],
};

function context(account: AztecAddress, over: Partial<TokenContext> = {}): TokenContext {
  return Object.assign(Object.create(null), {
    node: { getContract: async (address: AztecAddress) => ({ address, currentContractClassId: inferenceClassId }) },
    wallet: { registerContract: async () => {} },
    account,
    ...over,
  });
}

const list: sdk.MerchantList = { block: 1, at: 1n, entries: new Map() };

function stubSdk(over: Record<string, unknown>) {
  mock.module("@galactica-net/inference-money-core", () => ({ ...sdk, syncMerchantList: async () => list, ...over }));
}

describe("ref payments in the inference-money token", () => {
  test("the buyer pays through its gate, with the reference as a field", async () => {
    const payPrivate = mock(async (_gate: unknown, _wallet: unknown, _token: unknown, _intent: sdk.RefPaymentIntent, _opts: sdk.ListOptions) => proof);
    stubSdk({ payPrivate });
    const gate = Object.create(null);
    const token = await new TokenRegistry(context(USER, { paymentGate: gate })).get(INFERENCE);
    expect(await token.payPrivate?.(MERCHANT, 10n, REF)).toEqual(proof);
    const [usedGate, , , intent, opts] = payPrivate.mock.calls[0] ?? [];
    expect(usedGate).toBe(gate);
    expect(intent?.to.equals(MERCHANT)).toBe(true);
    expect(intent?.paymentRef.equals(Fr.fromHexString(REF))).toBe(true);
    // No sponsor in this session: the account pays its own fee, a choice the SDK wants spelled out.
    expect(opts?.fee).toBe("account-public");
  });

  test("paying needs the gate, and a gate refusal is a CLI error", async () => {
    stubSdk({ payPrivate: async () => Promise.reject(new sdk.PaymentRefusedError("completed-on-chain")) });
    const noGate = await new TokenRegistry(context(USER)).get(INFERENCE);
    await expect(noGate.payPrivate?.(MERCHANT, 10n, REF)).rejects.toThrow(/createPaymentGate/);
    const token = await new TokenRegistry(context(USER, { paymentGate: Object.create(null) })).get(INFERENCE);
    await expect(token.payPrivate?.(MERCHANT, 10n, REF)).rejects.toMatchObject({ code: "payment_refused" });
  });

  test("the merchant's verdict: paid, retry later while not mined, refused otherwise", async () => {
    let next: () => Promise<unknown> = async () => ({ txHash: { toString: () => H("cc") }, paymentRef: Fr.ZERO, amount: 12n });
    stubSdk({ receivePayment: () => next() });
    const token = await new TokenRegistry(context(MERCHANT)).get(INFERENCE);
    const expected = { paymentRef: REF, price: 10n };

    expect(await token.receivePayment?.(proof, expected)).toEqual({ isValid: true, amountFound: 12n, transaction: H("cc") });

    next = async () => Promise.reject(new sdk.PaymentProofRefusedError("not-mined", "pending"));
    expect(await token.receivePayment?.(proof, expected)).toMatchObject({ isValid: false, reason: "not-mined", retryable: true });

    next = async () => Promise.reject(new sdk.PaymentProofRefusedError("underpaid", "paid 1"));
    expect(await token.receivePayment?.(proof, expected)).toMatchObject({ isValid: false, reason: "underpaid", retryable: false });

    next = async () => Promise.reject(new Error("node down"));
    await expect(token.receivePayment?.(proof, expected)).rejects.toThrow("node down");
  });
});

describe("split claims", () => {
  test("survive serialization with every field", () => {
    const claim: sdk.SplitClaim = {
      amount: 5_000_000n,
      depositor: `0x${"12".repeat(20)}`,
      leafIndex: 7n,
      messageHash: H("34"),
      merchant: MERCHANT,
      price: 10_000n,
      paymentRef: Fr.fromHexString(REF),
      changeCommitment: new Fr(5n),
      salt: new Fr(6n),
    };
    const splitProof = { l1TxHash: H("ee"), price: "10000", paymentRef: REF, changeCommitment: new Fr(5n).toString(), salt: new Fr(6n).toString() };
    const back = parseSplitClaim(serializeSplitClaim(claim, splitProof));
    expect(back.proof).toEqual(splitProof);
    expect(back.claim.amount).toBe(5_000_000n);
    expect(back.claim.leafIndex).toBe(7n);
    expect(back.claim.merchant.equals(MERCHANT)).toBe(true);
    expect(back.claim.salt.equals(new Fr(6n))).toBe(true);
    expect(back.claim.depositor).toBe(claim.depositor);
  });
});

describe("merchant jobs", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  async function storeWithProof(store: PaymentStateStore, ref = REF) {
    await store.saveProof({
      paymentRef: ref,
      nonce: "n",
      mode: "ref",
      asset: INFERENCE,
      payload: JSON.stringify({ mode: "ref", ...proof, paymentRef: ref }),
      price: "10",
      receivedAt: Date.now(),
      takenIn: false,
    });
  }

  test("take in the proofs stored before a crash, and keep those that do not verify yet", async () => {
    const store = memoryStateStore();
    await storeWithProof(store, H("01"));
    await storeWithProof(store, H("02"));
    const receive = mock(async (_asset: string, p: { paymentRef: string }) =>
      p.paymentRef === H("01") ? { isValid: true } : { isValid: false, reason: "not-mined", retryable: true },
    );
    const jobs = new MerchantJobs({ store, receive });
    expect(await jobs.replayProofs()).toEqual({ taken: 1, pending: 1 });
    expect(receive.mock.calls[0]?.[2]).toEqual({ paymentRef: H("01"), price: 10n });
    expect((await store.proofsNotTakenIn(0)).map((p) => p.paymentRef)).toEqual([H("02")]);
  });

  const pending = (ref = REF): StoredSplitClaim => ({
    paymentRef: ref,
    asset: INFERENCE,
    claim: "{}",
    status: "pending",
    attempts: 0,
    nextTryAt: 0,
    updatedAt: 0,
  });

  function claimer(outcomes: Array<Awaited<ReturnType<SplitClaimer["claim"]>> | Error>, rebuilt?: string): SplitClaimer & { rebuilds: number } {
    const c = {
      rebuilds: 0,
      claim: async () => {
        const o = outcomes.shift() ?? "not-ready";
        if (o instanceof Error) throw o;
        return o;
      },
      rebuild: async () => {
        c.rebuilds++;
        return rebuilt;
      },
    };
    return c;
  }

  test("claim a served split deposit once it is consumable, backing off meanwhile", async () => {
    const store = memoryStateStore();
    await store.saveSplitClaim(pending());
    let now = 1_000_000;
    const jobs = new MerchantJobs({ store, receive: async () => ({ isValid: true }), split: claimer(["not-ready", new sdk.SponsorUnavailableError("busy"), "claimed"]), now: () => now });

    await jobs.claimDue();
    let [c] = await store.splitClaims();
    expect(c).toMatchObject({ status: "pending", attempts: 1, lastError: "message not consumable yet" });
    expect(c?.nextTryAt).toBeGreaterThan(now);

    await jobs.claimDue(); // not due yet: nothing happens
    expect((await store.splitClaims())[0]?.attempts).toBe(1);

    now = c?.nextTryAt ?? now;
    await jobs.claimDue();
    [c] = await store.splitClaims();
    expect(c).toMatchObject({ status: "pending", attempts: 2 });
    expect(c?.lastError).toContain("busy");

    now = c?.nextTryAt ?? now;
    await jobs.claimDue();
    expect((await store.splitClaims())[0]).toMatchObject({ status: "claimed", attempts: 3 });
  });

  test("record a deposit consumed by someone else, and rebuild a claim that stays unconsumable", async () => {
    const store = memoryStateStore();
    await store.saveSplitClaim(pending(H("01")));
    await store.saveSplitClaim({ ...pending(H("02")), attempts: 9 });
    await store.saveSplitClaim({ ...pending(H("03")), attempts: 9 });
    const outcomes: Record<string, Awaited<ReturnType<SplitClaimer["claim"]>>> = {};
    const split = claimer([], '{"rebuilt":1}');
    const jobs = new MerchantJobs({
      store,
      receive: async () => ({ isValid: true }),
      split: {
        claim: async (json) => outcomes[json] ?? "not-ready",
        rebuild: split.rebuild,
      },
    });
    outcomes["{}"] = "not-ready";
    // H(01): someone else claimed it.
    await store.updateSplitClaim(H("01"), { claim: "first" });
    outcomes.first = "consumed-unknown";
    await jobs.claimDue();
    const byRef = new Map((await store.splitClaims()).map((c) => [c.paymentRef, c]));
    expect(byRef.get(H("01"))?.status).toBe("consumed-unknown");
    // The tenth not-ready attempt rebuilds the claim from L1.
    expect(byRef.get(H("02"))).toMatchObject({ status: "pending", attempts: 10, claim: '{"rebuilt":1}' });
    expect(split.rebuilds).toBe(2);
  });

  test("give a claim up only when its deposit no longer verifies on L1", async () => {
    const store = memoryStateStore();
    await store.saveSplitClaim({ ...pending(), attempts: 9 });
    const jobs = new MerchantJobs({ store, receive: async () => ({ isValid: true }), split: claimer([], undefined) });
    await jobs.claimDue();
    expect((await store.splitClaims())[0]).toMatchObject({ status: "failed", lastError: "the deposit no longer verifies on L1" });
  });

  test("resume pending claims after a restart (SQLite)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-jobs-"));
    dirs.push(dir);
    const file = join(dir, "state.sqlite");
    const first = sqliteStateStore(file);
    await first.saveSplitClaim(pending());
    await new MerchantJobs({ store: first, receive: async () => ({ isValid: true }), split: claimer(["not-ready"]) }).claimDue();
    first.close?.();

    const second = sqliteStateStore(file);
    const later = Date.now() + 3_600_000;
    await new MerchantJobs({ store: second, receive: async () => ({ isValid: true }), split: claimer(["claimed"]), now: () => later }).claimDue();
    expect((await second.splitClaims())[0]).toMatchObject({ status: "claimed", attempts: 2 });
    second.close?.();
  });

  test("consolidate at start, and again only once a payment was taken in since", async () => {
    const store = memoryStateStore();
    const consolidate = mock(async () => {});
    const open = () => new MerchantJobs({ store, receive: async () => ({ isValid: true }), consolidate });

    // Nothing recorded yet (a new store, or one from before consolidations were recorded): consolidate at start.
    const first = open();
    await first.start();
    await first.stop();
    expect(consolidate).toHaveBeenCalledTimes(1);
    expect(await store.consolidatedAt()).toBeNumber();

    // A restart with nothing new taken in: no transaction.
    const second = open();
    await second.start();
    await second.stop();
    expect(consolidate).toHaveBeenCalledTimes(1);

    // A payment taken in since: the next start consolidates it.
    await new Promise((r) => setTimeout(r, 2));
    await storeWithProof(store);
    await store.markTakenIn(REF);
    await new Promise((r) => setTimeout(r, 2)); // a payment in the same ms as the start counts again, by design
    const third = open();
    await third.start();
    await third.stop();
    expect(consolidate).toHaveBeenCalledTimes(2);
    expect(await third.consolidateIfDue()).toBe(false);
  });

  test("retry a failed consolidation before the next scheduled run, and record only a success", async () => {
    const store = memoryStateStore();
    let calls = 0;
    const consolidate = async () => {
      if (++calls === 1) throw new Error("sponsor busy");
    };
    const jobs = new MerchantJobs({ store, receive: async () => ({ isValid: true }), consolidate, consolidateEveryMs: 20 });
    await jobs.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(await store.consolidatedAt()).toBeUndefined();
    for (let i = 0; i < 50 && calls < 2; i++) await new Promise((r) => setTimeout(r, 10));
    await jobs.stop();
    expect(calls).toBe(2);
    expect(await store.consolidatedAt()).toBeNumber();
  });

  test("one of two instances on a store runs the jobs; the other takes over when it stops", async () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-jobs-"));
    dirs.push(dir);
    const file = join(dir, "state.sqlite");
    const [storeA, storeB] = [sqliteStateStore(file), sqliteStateStore(file)];
    const consolidated: string[] = [];
    const open = (store: PaymentStateStore, name: string) =>
      new MerchantJobs({ store, receive: async () => ({ isValid: true }), consolidate: async () => void consolidated.push(name), instanceId: name, leaseMs: 30 });

    const a = open(storeA, "a");
    const b = open(storeB, "b");
    await a.start();
    await b.start();
    expect([a.isLeader, b.isLeader]).toEqual([true, false]);
    await new Promise((r) => setTimeout(r, 5));
    expect(consolidated).toEqual(["a"]);

    await a.stop(); // gives the lease up
    for (let i = 0; i < 50 && !b.isLeader; i++) await new Promise((r) => setTimeout(r, 5));
    expect(b.isLeader).toBe(true);
    expect((await b.status()).leader).toBe(true);
    await b.stop();
    storeA.close?.();
    storeB.close?.();
  });

  test("an instance whose lease ran out (a frozen process) is replaced", async () => {
    const store = memoryStateStore();
    let t = 1_000;
    // A frozen leader: it took the lease and never renews it.
    expect(await store.acquireLease("merchant-jobs", "frozen", 30, t)).toBe(true);
    const b = new MerchantJobs({ store, receive: async () => ({ isValid: true }), instanceId: "b", leaseMs: 30, now: () => t });
    await b.start();
    expect(b.isLeader).toBe(false);
    t += 31; // the frozen lease expires; b's renewal timer (every 10 ms) takes it
    for (let i = 0; i < 50 && !b.isLeader; i++) await new Promise((r) => setTimeout(r, 5));
    expect(b.isLeader).toBe(true);
    await b.stop();
  });

  test("before consolidating, take in every payment since the last consolidation, also those taken in already", async () => {
    const store = memoryStateStore();
    await storeWithProof(store, H("01"));
    await store.markTakenIn(H("01")); // another instance's wallet took this one in
    await storeWithProof(store, H("02"));
    const order: string[] = [];
    const jobs = new MerchantJobs({
      store,
      receive: async (_asset, p) => (order.push(p.paymentRef), { isValid: true }),
      consolidate: async () => void order.push("consolidate"),
    });
    expect(await jobs.consolidateIfDue()).toBe(true);
    expect(order).toEqual([H("01"), H("02"), "consolidate"]);
    expect(await store.proofsNotTakenIn(0)).toHaveLength(0);
  });

  test("report the jobs' state, with warnings for a payment waiting long for consolidation", async () => {
    const store = memoryStateStore();
    let t = Date.now();
    const jobs = new MerchantJobs({ store, receive: async () => ({ isValid: true }), now: () => t });
    expect(await jobs.status()).toEqual({
      leader: false,
      unconsolidated: { count: 0 },
      proofsNotTakenIn: 0,
      splitClaims: { pending: 0, failed: 0, consumedUnknown: 0 },
      warnings: [],
    });
    await storeWithProof(store, H("01"));
    await store.markTakenIn(H("01"));
    await storeWithProof(store, H("02"));
    await store.saveSplitClaim({ ...pending(H("03")), status: "failed" });
    let status = await jobs.status();
    expect(status.unconsolidated.count).toBe(1);
    expect(status.proofsNotTakenIn).toBe(1);
    expect(status.splitClaims.failed).toBe(1);
    expect(status.warnings).toHaveLength(1); // the failed claim

    t += 13 * 3600_000;
    status = await jobs.status();
    expect(status.warnings.some((w) => w.includes("waited 13 h for consolidation"))).toBe(true);
    expect(status.warnings.some((w) => w.includes("not been taken into the wallet"))).toBe(true);
    t += 8 * 3600_000;
    expect((await jobs.status()).warnings.some((w) => w.includes("after 26 h"))).toBe(true);
  });

  test("run one job at a time", async () => {
    const store = memoryStateStore();
    await storeWithProof(store);
    let running = 0;
    let most = 0;
    const busy = async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    };
    const jobs = new MerchantJobs({
      store,
      receive: async () => (await busy(), { isValid: true }),
      consolidate: busy,
    });
    await Promise.all([jobs.replayProofs(), jobs.consolidateNow(), jobs.consolidateNow()]);
    expect(most).toBe(1);
  });
});
