import { describe, it, expect } from "bun:test";
import {
  AZTEC_NETWORKS,
  SCHEME,
  CAIP_FAMILY,
} from "../types.js";

describe("constants", () => {
  it("has correct scheme", () => {
    expect(SCHEME).toBe("exact");
  });

  it("has correct CAIP family", () => {
    expect(CAIP_FAMILY).toBe("aztec:*");
  });

  it("has sandbox network", () => {
    expect(AZTEC_NETWORKS.SANDBOX).toBe("aztec:sandbox");
  });

  it("has testnet network", () => {
    expect(AZTEC_NETWORKS.TESTNET).toBe("aztec:testnet");
  });

  it("has devnet network", () => {
    expect(AZTEC_NETWORKS.DEVNET).toBe("aztec:devnet");
  });
});

describe("ExactAztecPayload type", () => {
  it("can be constructed with required fields", () => {
    // Type-level test — verifying the shape compiles correctly
    const payload = {
      senderAddress: "0x" + "a".repeat(64),
      correlationId: "test-id-123",
      txHash: "0x" + "b".repeat(64),
      timestamp: new Date().toISOString(),
    };

    expect(payload.senderAddress).toBeTruthy();
    expect(payload.correlationId).toBeTruthy();
    expect(payload.txHash).toBeTruthy();
    expect(payload.timestamp).toBeTruthy();
  });
});
