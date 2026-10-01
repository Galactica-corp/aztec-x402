/**
 * Errors the CLI reports as structured JSON (`{ ok: false, error: { code, message } }`)
 * without a stack trace. Anything else is an unexpected failure.
 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** The CLI was called wrongly, or local state is missing. */
export class UsageError extends CliError {
  constructor(message: string, code = "usage", details?: Record<string, unknown>) {
    super(message, code, details);
  }
}

/** A payment was refused by the spend policy before any money moved. */
export class PolicyError extends CliError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "policy_rejected", details);
  }
}

/** The Aztec node could not be reached; nothing was sent. */
export class NodeUnreachableError extends CliError {
  constructor(nodeUrl: string, cause: unknown) {
    // The SDK's fetch errors embed a stack trace; the first line says what happened.
    super(`Aztec node ${nodeUrl} is unreachable: ${messageOf(cause).split("\n")[0]}`, "node_unreachable", { nodeUrl });
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Proof generation runs before a transaction is sent, so a prover failure
 * means nothing was submitted. Barretenberg surfaces it as BBApiException,
 * including when it cannot download its CRS on first use.
 */
export function isProverError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "BBApiException" || /\bCRS\b|barretenberg|ClientIVC proof|bb\.js/i.test(error.message);
}

export function proverFailed(error: unknown): CliError {
  return new CliError(
    `Proof generation failed, so no transaction was submitted: ${messageOf(error)}`,
    "prover_failed",
    { txSubmitted: false },
  );
}
