import { describe, expect, test } from "bun:test";
import { publicDrpcMaxBatchSize } from "../aztec/node-client.js";

describe("public dRPC batch cap", () => {
  test("caps the public host", () => {
    expect(publicDrpcMaxBatchSize("https://aztec-testnet.drpc.org")).toBe(3);
    expect(publicDrpcMaxBatchSize("https://aztec-testnet.drpc.org/")).toBe(3);
  });

  test("leaves a keyed endpoint uncapped", () => {
    expect(publicDrpcMaxBatchSize("https://lb.drpc.live/aztec-testnet/secret")).toBeUndefined();
    expect(publicDrpcMaxBatchSize("https://aztec-testnet.drpc.org/secret")).toBeUndefined();
    expect(publicDrpcMaxBatchSize("https://lb.drpc.org/ogrpc?network=aztec-testnet&dkey=secret")).toBeUndefined();
  });

  test("leaves other nodes uncapped", () => {
    expect(publicDrpcMaxBatchSize("http://localhost:8080")).toBeUndefined();
  });
});
