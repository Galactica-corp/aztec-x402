/**
 * Output conventions: the result is one JSON document on stdout; progress
 * lines go to stderr so agents can parse stdout and still show the user
 * what is happening during slow proving steps.
 */
let quiet = false;

export function setQuiet(value: boolean): void {
  quiet = value;
}

export function progress(message: string): void {
  if (!quiet) process.stderr.write(`[aztec-x402] ${message}\n`);
}

export function printJson(value: unknown): void {
  process.stdout.write(
    JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n",
  );
}
