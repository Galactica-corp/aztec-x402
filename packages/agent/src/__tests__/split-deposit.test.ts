/**
 * Finding a split deposit: hashes the local funding page reports are hints.
 * A wrong or made-up one can neither pin the payment nor stop the search.
 */
import { describe, expect, test } from "bun:test";
import { awaitSplitDeposit, DepositTimeoutError } from "../commands/pay-split.js";
import { CliError } from "../errors.js";

const H = (b: string) => "0x" + b.repeat(32);
const REAL = H("aa");
const OTHER_TX = H("bb");
const MADE_UP = H("cc");

/** L1 as the confirm step sees it: the real deposit, another mined tx, and hashes that do not exist. */
function chain(opts: { foundAfter?: number } = {}) {
  let round = 0;
  const tried: string[] = [];
  return {
    tried,
    find: async () => (++round > (opts.foundAfter ?? 0) ? REAL : undefined),
    confirm: async (hash: string) => {
      tried.push(hash);
      if (hash === REAL) return "ticket";
      if (hash === OTHER_TX) throw new CliError(`${hash} is not this payment's deposit.`, "deposit_mismatch");
      throw new Error("TransactionReceiptNotFoundError");
    },
  };
}

describe("awaitSplitDeposit", () => {
  test("a made-up reported hash does not stop the search for the real deposit", async () => {
    const l1 = chain({ foundAfter: 2 });
    const result = await awaitSplitDeposit({ ...l1, hints: () => [MADE_UP], deadline: Date.now() + 60_000, pollMs: 1 });
    expect(result).toEqual({ ticket: "ticket", l1TxHash: REAL });
  });

  test("a reported hash of another transaction is tried once, then dropped", async () => {
    const l1 = chain({ foundAfter: 3 });
    const result = await awaitSplitDeposit({ ...l1, hints: () => [OTHER_TX], deadline: Date.now() + 60_000, pollMs: 1 });
    expect(result.l1TxHash).toBe(REAL);
    expect(l1.tried.filter((h) => h === OTHER_TX)).toHaveLength(1);
  });

  test("a reported hash that is the real deposit is used before the search finds it", async () => {
    const l1 = chain({ foundAfter: 100 });
    const result = await awaitSplitDeposit({ ...l1, hints: () => [REAL.toUpperCase().replace("0X", "0x")], deadline: Date.now() + 60_000, pollMs: 1 });
    expect(result.l1TxHash).toBe(REAL);
  });

  test("with only bogus reports and no deposit, it gives up at the deadline", async () => {
    const l1 = chain({ foundAfter: Number.POSITIVE_INFINITY });
    const waiting = awaitSplitDeposit({ ...l1, hints: () => [MADE_UP, OTHER_TX], deadline: Date.now() + 30, pollMs: 5 });
    expect(waiting).rejects.toBeInstanceOf(DepositTimeoutError);
    await waiting.catch(() => undefined);
  });
});
