/**
 * x402 on Aztec — Constants
 */

/** Default token decimals (stablecoins like USDC typically use 6) */
export const DEFAULT_TOKEN_DECIMALS = 6;

/** Maximum payment timeout in seconds (5 minutes) */
export const MAX_TIMEOUT_SECONDS = 300;

/** Default payment timeout in seconds (2 minutes) */
export const DEFAULT_TIMEOUT_SECONDS = 120;

/**
 * PXE note discovery polling interval in milliseconds.
 * After a client submits a private transfer, the server polls
 * its PXE for the incoming note at this interval.
 */
export const NOTE_DISCOVERY_POLL_INTERVAL_MS = 2000;

/**
 * Maximum time to wait for note discovery in milliseconds.
 * If the note hasn't appeared after this time, verification fails.
 */
export const NOTE_DISCOVERY_TIMEOUT_MS = 120_000;

/**
 * Number of retry attempts for note discovery.
 * Each attempt waits NOTE_DISCOVERY_POLL_INTERVAL_MS.
 */
export const NOTE_DISCOVERY_MAX_RETRIES = Math.floor(
  NOTE_DISCOVERY_TIMEOUT_MS / NOTE_DISCOVERY_POLL_INTERVAL_MS,
);
