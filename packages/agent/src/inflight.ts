/**
 * The payment currently being proven or sent, if any. A crash that escapes
 * the command's own error handling (e.g. a prover failure raised from a
 * worker callback) still settles the ledger entry from here.
 */
let current: { dataDir: string; id: string } | undefined;

export function setInflightPayment(payment: { dataDir: string; id: string } | undefined): void {
  current = payment;
}

export function inflightPayment(): { dataDir: string; id: string } | undefined {
  return current;
}
