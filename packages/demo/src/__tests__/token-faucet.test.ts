/**
 * Unit tests for the demo token faucet helpers.
 *
 * Verifies that setup wires the Dripper as the token minter and mints via
 * `drip_to_private` (not Alice calling `mint_to_private` directly).
 */
import { describe, it, expect, jest } from "bun:test";

// Polyfill for @aztec/foundation which calls expect.addEqualityTesters at module load.
if (!Reflect.get(expect, "addEqualityTesters")) {
  Reflect.set(expect, "addEqualityTesters", () => {});
}

const { AztecAddress } = await import("@aztec/aztec.js/addresses");
const { DripperContract } = await import(
  "@aztec-foundation/aztec-standards/dist/src/artifacts/Dripper.js"
);
const { TokenContract } = await import(
  "@aztec-foundation/aztec-standards/dist/src/artifacts/Token.js"
);
const {
  dripToPrivate,
  tokenConstructorWithDripperArgs,
} = await import("../aztec/token-faucet.js");

const DRIPPER_ADDRESS_STR =
  "0x09ee8a90f9c3d7db87b55fb92a3bbfc69e65be5b8d4d135c756ecbfec37a1c01";
const TOKEN_ADDRESS_STR =
  "0x0abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const ALICE_ADDRESS_STR =
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const MINT_AMOUNT = 1_000_000n;

function functionNames(artifact: {
  functions: Array<{ name: string }>;
  nonDispatchPublicFunctions?: Array<{ name: string }>;
}): string[] {
  return [
    ...artifact.functions.map((fn) => fn.name),
    ...(artifact.nonDispatchPublicFunctions ?? []).map((fn) => fn.name),
  ];
}

describe("token faucet setup", () => {
  it("Dripper artifact exposes drip_to_private", () => {
    const names = functionNames(DripperContract.artifact);
    expect(names).toContain("drip_to_private");
    expect(names).toContain("drip_to_public");
  });

  it("Token artifact exposes constructor_with_minter and mint_to_private", () => {
    const names = functionNames(TokenContract.artifact);
    expect(names).toContain("constructor_with_minter");
    expect(names).toContain("mint_to_private");
  });

  it("tokenConstructorWithDripperArgs puts dripper as minter", () => {
    const dripper = AztecAddress.fromStringUnsafe(DRIPPER_ADDRESS_STR);
    const args = tokenConstructorWithDripperArgs("Overcast USD", "oUSD", 6, dripper);

    expect(args).toHaveLength(5);
    expect(args[0]).toBe("Overcast USD");
    expect(args[1]).toBe("oUSD");
    expect(args[2]).toBe(6);
    expect(args[3].toString()).toBe(dripper.toString());
    expect(args[4].equals(AztecAddress.ZERO)).toBe(true);
  });

  it("dripToPrivate simulates then sends drip_to_private for the caller", async () => {
    const tokenAddr = AztecAddress.fromStringUnsafe(TOKEN_ADDRESS_STR);
    const alice = AztecAddress.fromStringUnsafe(ALICE_ADDRESS_STR);
    const sendOpts = { from: alice, wait: { timeout: 240 } };

    const simulate = jest.fn(async () => ({ result: undefined }));
    const send = jest.fn(async () => ({ receipt: { status: "checkpointed" } }));
    const drip_to_private = jest.fn(() => ({ simulate, send }));

    const dripper = { methods: { drip_to_private } };

    await dripToPrivate(dripper, tokenAddr, MINT_AMOUNT, alice, sendOpts);

    expect(drip_to_private).toHaveBeenCalledTimes(2);
    expect(drip_to_private).toHaveBeenCalledWith(tokenAddr, MINT_AMOUNT);
    expect(simulate).toHaveBeenCalledWith({ from: alice });
    expect(send).toHaveBeenCalledWith(sendOpts);
    // Caller must not mint on the token directly — faucet is the minter.
    expect(drip_to_private.mock.calls[0]?.[0]).toBe(tokenAddr);
  });
});
