#!/usr/bin/env node
/**
 * Entry point. The Aztec SDK reads LOG_LEVEL when its modules load, so set a
 * quiet default before importing anything that pulls it in.
 */
const verbose = process.argv.includes("--verbose");
process.env.LOG_LEVEL ??= verbose ? "info" : "silent";

const { main, reportError } = await import("./main.js");

// The prover and node client can fail from callbacks outside the command's
// await chain; those must still end in one JSON document, not a raw stack.
const fatal = (error: unknown) => {
  process.exitCode = reportError(error);
  process.stdout.write("", () => process.exit());
};
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

process.exitCode = await main(process.argv.slice(2));
// Aztec's node client and PXE keep handles open; leave once output is flushed.
process.stdout.write("", () => process.exit());

export {};
