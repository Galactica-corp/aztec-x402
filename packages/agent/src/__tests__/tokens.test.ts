import { describe, expect, mock, test } from "bun:test";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract";
import { TokenContract } from "@aztec-foundation/aztec-standards/dist/src/artifacts/Token.js";
import * as sdk from "@galactica-net/inference-money-core";
import { TESTNET_MANIFEST } from "@galactica-net/inference-money-core/deployments";
import { RealClientAztecSigner } from "../aztec/client-signer.js";
import type { TokenAdapter, TokenContext } from "../aztec/tokens/adapter.js";
import { identifyToken, paymentGateFor, TokenRegistry } from "../aztec/tokens/registry.js";
import { NETWORKS } from "../networks.js";

const AIP20 = "0x0a" + "a1".repeat(31);
const INFERENCE = "0x0a" + "b2".repeat(31);
const OTHER = "0x0a" + "c3".repeat(31);
const MERCHANT = AztecAddress.fromStringUnsafe("0x09ee8a90f9c3d7db87b55fb92a3bbfc69e65be5b8d4d135c756ecbfec37a1c01");
const USER = AztecAddress.fromStringUnsafe("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");

const aip20ClassId = (await getContractClassFromArtifact(TokenContract.artifact)).id;
const inferenceClassId = (await getContractClassFromArtifact(sdk.tokenArtifact)).id;

/** A node that knows three contracts: one of each supported class, and one of an unknown class. */
function fakeNode() {
  const classes: Record<string, Fr> = { [AIP20]: aip20ClassId, [INFERENCE]: inferenceClassId, [OTHER]: new Fr(1234n) };
  return {
    getContract: mock(async (address: AztecAddress) => {
      const classId = classes[address.toString()];
      return classId ? { address, currentContractClassId: classId } : undefined;
    }),
  };
}

/** Only the members set here are reached without a network; `Object.create` leaves the rest untyped. */
function fakeContext(account = USER): TokenContext {
  return Object.assign(Object.create(null), {
    node: fakeNode(),
    wallet: { registerContract: mock(async () => {}) },
    account,
  });
}

/** The merchant list the SDK would sync: MERCHANT is listed and switched on. */
function listWith(...merchants: AztecAddress[]): sdk.MerchantList {
  const entry = { off: false, scheduledOff: false, changeAt: 0n, delay: undefined, scheduledDelay: undefined, delayChangeAt: 0n };
  return { block: 1, at: 1_000n, entries: new Map(merchants.map((m) => [m.toString(), entry])) };
}

function stubMerchantList(list: sdk.MerchantList) {
  mock.module("@galactica-net/inference-money-core", () => ({ ...sdk, syncMerchantList: async () => list }));
}

describe("identifyToken", () => {
  test("reads the kind from the deployed contract's class", async () => {
    const node = fakeNode();
    expect((await identifyToken(node, AIP20)).kind).toBe("aip20");
    expect((await identifyToken(node, INFERENCE)).kind).toBe("inference-money");
  });

  test("refuses a contract of any other class, and an address with no contract", async () => {
    const node = fakeNode();
    await expect(identifyToken(node, OTHER)).rejects.toMatchObject({ code: "unsupported_token" });
    await expect(identifyToken(node, "0x" + "01".repeat(32))).rejects.toMatchObject({ code: "token_not_found" });
  });

  test("the testnet USDC in the registry is the inference-money deployment this SDK version ships", () => {
    const usdc = NETWORKS.testnet.tokens.find((t) => t.symbol === "USDC");
    expect(usdc?.address).toBe(TESTNET_MANIFEST.l2.token.address);
    expect(inferenceClassId.toString()).toBe(TESTNET_MANIFEST.l2.token.classId);
    expect(NETWORKS.testnet.tokens.find((t) => t.dripper)?.symbol).toBe("tUSDC");
  });
});

describe("paymentGateFor", () => {
  test("only the inference-money token needs the buyer's wallet built through a gate", async () => {
    const node = fakeContext().node;
    expect(await paymentGateFor(node, AIP20)).toBeUndefined();
    expect(await paymentGateFor(node, INFERENCE)).toBeInstanceOf(sdk.PaymentGate);
  });
});

describe("TokenRegistry", () => {
  test("returns one adapter per token, of the detected kind, registered with the wallet once", async () => {
    const ctx = fakeContext();
    const tokens = new TokenRegistry(ctx);
    const [a, again, b] = await Promise.all([tokens.get(AIP20), tokens.get(AIP20.toUpperCase().replace("0X", "0x")), tokens.get(INFERENCE)]);
    expect(a.kind).toBe("aip20");
    expect(again).toBe(a);
    expect(b.kind).toBe("inference-money");
    expect(ctx.wallet.registerContract).toHaveBeenCalledTimes(2);
  });

  test("a failed lookup is not cached", async () => {
    const ctx = fakeContext();
    const tokens = new TokenRegistry(ctx);
    const getContract = ctx.node.getContract;
    ctx.node.getContract = async () => {
      throw new Error("node down");
    };
    await expect(tokens.get(AIP20)).rejects.toThrow("node down");
    ctx.node.getContract = getContract;
    expect((await tokens.get(AIP20)).kind).toBe("aip20");
  });
});

describe("RealClientAztecSigner", () => {
  test("pays through the adapter of the token the challenge names", async () => {
    const paid: string[] = [];
    const adapter = (name: string): TokenAdapter =>
      Object.assign(Object.create(null), {
        pay: async (commitment: string, amount: bigint) => {
          paid.push(`${name}:${commitment}:${amount}`);
          return `tx-${name}`;
        },
      });
    const adapters: Record<string, TokenAdapter> = { [AIP20]: adapter("aip20"), [INFERENCE]: adapter("inference") };
    const signer = new RealClientAztecSigner({ address: USER }, { get: async (address) => adapters[address] });

    expect(await signer.finalizePayment(INFERENCE, "0x01", 5n)).toBe("tx-inference");
    expect(await signer.finalizePayment(AIP20, "0x02", 7n)).toBe("tx-aip20");
    expect(paid).toEqual(["inference:0x01:5", "aip20:0x02:7"]);
    // A token without offchain delivery simply has nothing to process.
    await signer.processOffchainMessage(INFERENCE, "[]", "0x00");
  });
});

describe("inference-money token rules", () => {
  test("only a listed merchant can sell", async () => {
    stubMerchantList(listWith(MERCHANT));
    const asMerchant = await new TokenRegistry(fakeContext(MERCHANT)).get(INFERENCE);
    const asUser = await new TokenRegistry(fakeContext(USER)).get(INFERENCE);
    await asMerchant.assertCanSell();
    await expect(asUser.assertCanSell()).rejects.toMatchObject({ code: "merchant_not_listed" });
  });

  test("a user's payment to an unlisted payee is refused before the merchant prepares", async () => {
    stubMerchantList(listWith(MERCHANT));
    const token = await new TokenRegistry(fakeContext(USER)).get(INFERENCE);
    await token.preflight(MERCHANT);
    await expect(token.preflight(AztecAddress.fromStringUnsafe(OTHER))).rejects.toMatchObject({
      code: "merchant_not_listed",
    });
  });

  test("paying needs a wallet built through the payment gate", async () => {
    const token = await new TokenRegistry(fakeContext(USER)).get(INFERENCE);
    await expect(token.pay("0x01", 1n)).rejects.toThrow(/createPaymentGate/);
  });

  test("the AIP-20 token has no such rules", async () => {
    const token = await new TokenRegistry(fakeContext(USER)).get(AIP20);
    await token.assertCanSell();
    await token.preflight(AztecAddress.fromStringUnsafe(OTHER));
  });

  test("refusals surface as CLI errors with a code", async () => {
    const { asTokenError } = await import("../aztec/tokens/inference.js");
    expect(asTokenError(new sdk.PaymentRefusedError("completed-on-chain"))).toMatchObject({
      code: "payment_refused",
      details: { reason: "completed-on-chain" },
    });
    expect(asTokenError(new Error(`Assertion failed: ${sdk.TOKEN_REFUSALS.request}`))).toMatchObject({
      code: "token_refused",
      details: { rule: "request" },
    });
    const other = new Error("socket hang up");
    expect(asTokenError(other)).toBe(other);
  });
});
