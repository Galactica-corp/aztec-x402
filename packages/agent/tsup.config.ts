import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts", "aztec/index": "src/aztec/index.ts" },
  format: ["esm"],
  dts: { entry: { "aztec/index": "src/aztec/index.ts" } },
  clean: true,
  sourcemap: true,
  target: "node22",
});
