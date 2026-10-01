/**
 * Output conventions: the result is one JSON document on stdout; progress
 * lines go to stderr so agents can parse stdout and still show the user
 * what is happening during slow proving steps.
 */
let quiet = false;
let printed = false;

export function setQuiet(value: boolean): void {
  quiet = value;
}

export function progress(message: string): void {
  if (!quiet) process.stderr.write(`[aztec-x402] ${message}\n`);
}

/** Start of a command: nothing written yet. */
export function resetOutput(): void {
  printed = false;
}

/** Whether the single stdout JSON document has been written. */
export function hasPrinted(): boolean {
  return printed;
}

export function printJson(value: unknown): void {
  printed = true;
  process.stdout.write(
    JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n",
  );
}
