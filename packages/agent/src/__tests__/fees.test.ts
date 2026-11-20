import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { MAINNET_MANIFEST, TESTNET_MANIFEST } from "@galactica-net/inference-money-core/deployments";
import { resolveContext } from "../config.js";
import { CliError } from "../errors.js";
import { assertFeeConsent, assertHoldsFeeJuice, feeMode } from "../fees.js";
import { builtInBridge, NETWORKS } from "../networks.js";
import { bridgeManifestFor } from "../fund/split.js";
import { FeeJuiceBridge } from "../fund/fee-juice.js";
import type { Session } from "../aztec/session.js";
import type { DepositRecord } from "../fund/deposits.js";

const AGENT = AztecAddress.fromStringUnsafe("0x" + "0a".repeat(32));
const mainnet = NETWORKS.mainnet;
const testnet = NETWORKS.testnet;

function refusal(fn: () => unknown): CliError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("the mainnet network", () => {
  test("pays in the bridged USDC of the mainnet deployment, on Ethereum, with no sponsor", () => {
    expect(mainnet.caip2).toBe("aztec:mainnet");
    expect(mainnet.l1ChainId).toBe(MAINNET_MANIFEST.l1.chainId);
    expect(mainnet.sponsoredFees).toBe(false);
    expect(mainnet.tokens.map((t) => [t.symbol, t.address])).toEqual([["USDC", MAINNET_MANIFEST.l2.token.address]]);
    expect(MAINNET_MANIFEST.l2.sponsoredFpc).toBeUndefined();
  });

  test("each network uses its own bridge deployment, and local none", () => {
    expect(builtInBridge(mainnet)).toBe(MAINNET_MANIFEST);
    expect(builtInBridge(testnet)).toBe(TESTNET_MANIFEST);
    expect(builtInBridge(NETWORKS.local)).toBeUndefined();
    expect(bridgeManifestFor(mainnet)?.l1.portal).toBe(MAINNET_MANIFEST.l1.portal);
  });
});

describe("fee consent", () => {
  test("is not needed where a sponsor pays", () => {
    const ctx = { network: testnet, publicFees: false };
    expect(feeMode(ctx)).toEqual({ payer: "sponsor" });
    expect(() => assertFeeConsent(ctx)).not.toThrow();
  });

  test("is required before the agent is named as fee payer on mainnet, and says how to give it", () => {
    const ctx = { network: mainnet, publicFees: false };
    expect(feeMode(ctx)).toEqual({ payer: "account", allowed: false });
    const error = refusal(() => assertFeeConsent(ctx));
    expect(error.code).toBe("public_fees_not_allowed");
    expect(error.message).toContain("config set publicFees true");
    expect(() => assertFeeConsent({ network: mainnet, publicFees: true })).not.toThrow();
  });

  describe("comes from the environment over the config file", () => {
    let previous: Record<string, string | undefined>;
    beforeEach(() => {
      previous = { home: process.env.AZTEC_X402_HOME, flag: process.env.AZTEC_X402_PUBLIC_FEES };
      process.env.AZTEC_X402_HOME = mkdtempSync(join(tmpdir(), "x402-fees-"));
    });
    afterEach(() => {
      for (const [key, name] of [["home", "AZTEC_X402_HOME"], ["flag", "AZTEC_X402_PUBLIC_FEES"]] as const) {
        if (previous[key] === undefined) delete process.env[name];
        else process.env[name] = previous[key];
      }
    });

    test("off unless given", async () => {
      delete process.env.AZTEC_X402_PUBLIC_FEES;
      expect(resolveContext("mainnet").publicFees).toBe(false);
      const { configSet } = await import("../commands/status.js");
      configSet("publicFees", "true");
      expect(resolveContext("mainnet").publicFees).toBe(true);
      process.env.AZTEC_X402_PUBLIC_FEES = "0";
      expect(resolveContext("mainnet").publicFees).toBe(false);
      process.env.AZTEC_X402_PUBLIC_FEES = "1";
      expect(resolveContext("mainnet").publicFees).toBe(true);
    });
  });
});

describe("the Fee Juice check", () => {
  const nodeHolding = (balance: bigint) =>
    Object.assign(Object.create(null), { getPublicStorageAt: mock(async () => new Fr(balance)) });

  test("refuses before proving when the agent pays its own fee and holds none", async () => {
    const node = nodeHolding(0n);
    const error: unknown = await assertHoldsFeeJuice({ network: mainnet }, node, AGENT).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: "no_fee_juice" });
    await assertHoldsFeeJuice({ network: mainnet }, nodeHolding(1n), AGENT);
  });

  test("is skipped where a sponsor pays", async () => {
    const node = nodeHolding(0n);
    await assertHoldsFeeJuice({ network: testnet }, node, AGENT);
    expect(node.getPublicStorageAt).not.toHaveBeenCalled();
  });
});

describe("a Fee Juice claim without a sponsor", () => {
  const bridge = FeeJuiceBridge.fromAddresses("http://127.0.0.1:1", {
    portal: `0x${"11".repeat(20)}`,
    token: `0x${"22".repeat(20)}`,
    symbol: "AZTEC",
  });
  const deposit: DepositRecord = Object.assign(Object.create(null), {
    recipient: AGENT.toString(),
    amount: "5000",
    secret: new Fr(7n).toString(),
    leafIndex: "3",
  });

  function session() {
    const sendTx = mock(async (_payload: unknown, _opts: unknown) => ({ receipt: { txHash: new Fr(9n) } }));
    const s: Session = Object.assign(Object.create(null), { address: AGENT, wallet: { sendTx }, sendOpts: { from: AGENT, wait: {} } });
    return { s, sendTx };
  }

  test("pays its own fee from the claim: the tx is the claim and names the agent as payer", async () => {
    const { s, sendTx } = session();
    expect(await bridge.claim(s, deposit)).toBe(new Fr(9n).toString());
    expect(sendTx).toHaveBeenCalledTimes(1);
    const payload: unknown = sendTx.mock.calls[0]?.[0];
    expect(payload).toMatchObject({ calls: [{ name: "claim_and_end_setup" }] });
    expect(String(Reflect.get(Object(payload), "feePayer"))).toBe(AGENT.toString());
  });

  test("refuses a deposit made out to another account", async () => {
    const { s, sendTx } = session();
    const other = { ...deposit, recipient: "0x" + "0b".repeat(32) };
    await expect(bridge.claim(s, other)).rejects.toThrow("not this agent");
    expect(sendTx).not.toHaveBeenCalled();
  });

  test("names the network's fee asset to the user", async () => {
    expect((await bridge.describe()).l1Token.symbol).toBe("AZTEC");
  });
});
