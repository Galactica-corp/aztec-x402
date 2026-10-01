#!/usr/bin/env node
/**
 * Entry point. The Aztec SDK reads LOG_LEVEL when its modules load, so set a
 * quiet default before importing anything that pulls it in.
 */
const verbose = process.argv.includes("--verbose");
process.env.LOG_LEVEL ??= verbose ? "info" : "silent";

const { main } = await import("./main.js");
process.exitCode = await main(process.argv.slice(2));
// Aztec's node client and PXE keep handles open; leave once output is flushed.
process.stdout.write("", () => process.exit());

export {};
