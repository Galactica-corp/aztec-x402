/**
 * Bun test preload script.
 *
 * @aztec/foundation registers custom equality testers via
 * expect.addEqualityTesters() at module load time. This is a Jest API
 * that bun:test doesn't support yet. Polyfill it as a no-op to prevent
 * "TypeError: expect.addEqualityTesters is not a function" errors
 * when tests import Aztec modules.
 */
import { expect } from "bun:test";

/**
 * Polyfill: @aztec/foundation calls expect.addEqualityTesters() at load time.
 * Bun's test runner doesn't support this Jest API, so we add a no-op.
 * Using Record indexing to avoid `as` type assertions (oxlint rule).
 */
if (typeof expect.addEqualityTesters === "undefined") {
  Object.defineProperty(expect, "addEqualityTesters", {
    value: () => {},
    writable: true,
    configurable: true,
  });
}
