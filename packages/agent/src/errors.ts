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
