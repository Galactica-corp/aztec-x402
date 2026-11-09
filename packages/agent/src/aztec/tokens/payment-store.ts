/**
 * The inference-money SDK's payment records, kept in a file: one record per
 * request, so a request this wallet has paid or is paying is refused before a
 * second proof, also across CLI runs and concurrent processes.
 *
 * Every key shares one lock, a lock file created exclusively. A lock older
 * than {@link STALE_LOCK_MS} was left by a process that died and is taken over.
 */
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import type { PaymentRecord, PaymentStore } from "@galactica-net/inference-money-core";

const STALE_LOCK_MS = 60_000;
const LOCK_RETRY_MS = 50;

async function acquire(lockPath: string): Promise<void> {
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx", 0o600));
      return;
    } catch (error) {
      if (!(error instanceof Error) || Reflect.get(error, "code") !== "EEXIST") throw error;
    }
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) unlinkSync(lockPath);
    } catch {
      // Released between the two calls; retry at once.
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}

export function filePaymentStore(path: string): PaymentStore {
  const lockPath = `${path}.lock`;
  // The SDK reads and writes inside `locked`; calls from this process queue up behind each other.
  let tail: Promise<unknown> = Promise.resolve();

  const read = (): Record<string, PaymentRecord> => (existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {});

  return {
    locked<T>(_key: string, fn: () => Promise<T>): Promise<T> {
      const run = tail.then(async () => {
        await acquire(lockPath);
        try {
          return await fn();
        } finally {
          unlinkSync(lockPath);
        }
      });
      tail = run.catch(() => undefined);
      return run;
    },
    get: async (key) => read()[key],
    put: async (key, record) => {
      const records = read();
      if (record) records[key] = record;
      else delete records[key];
      // Write-then-rename: a crash never leaves a half-written file.
      writeFileSync(`${path}.tmp`, JSON.stringify(records, null, 2) + "\n", { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    },
  };
}
