import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  // `sqlite` is a builtin only with its `node:` prefix.
  removeNodeProtocol: false,
});
