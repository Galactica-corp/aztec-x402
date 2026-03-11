import { DEFAULT_TOKEN_DECIMALS } from "./constants.js";

/**
 * Generate a unique correlation ID for a payment.
 * Uses crypto.randomUUID when available, falls back to timestamp + random.
 */
export function generateCorrelationId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Parse a human-readable price string (e.g., "$0.10", "0.5") into
 * the smallest token unit (e.g., 100000 for $0.10 USDC with 6 decimals).
 *
 * @param price - Human-readable price (number or string with optional $ prefix)
 * @param decimals - Token decimals (default: 6)
 * @returns Amount in smallest token units as bigint
 */
export function parsePrice(
  price: string | number,
  decimals: number = DEFAULT_TOKEN_DECIMALS,
): bigint {
  const numericStr =
    typeof price === "string" ? price.replace(/^\$/, "").trim() : String(price);

  const num = Number(numericStr);
  if (isNaN(num) || num < 0) {
    throw new Error(`Invalid price: ${price}`);
  }

  // Use string arithmetic to avoid floating point issues
  const parts = numericStr.split(".");
  const integerPart = parts[0] || "0";
  const fractionalPart = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);

  return BigInt(integerPart) * BigInt(10 ** decimals) + BigInt(fractionalPart);
}

/**
 * Format a token amount from smallest units to human-readable string.
 *
 * @param amount - Amount in smallest token units
 * @param decimals - Token decimals (default: 6)
 * @returns Human-readable amount string (e.g., "0.100000")
 */
export function formatAmount(
  amount: bigint,
  decimals: number = DEFAULT_TOKEN_DECIMALS,
): string {
  const divisor = BigInt(10 ** decimals);
  const integerPart = amount / divisor;
  const fractionalPart = amount % divisor;

  const fractionalStr = fractionalPart.toString().padStart(decimals, "0");
  return `${integerPart}.${fractionalStr}`;
}

/**
 * Validate an Aztec address string.
 * Aztec addresses are 32-byte hex strings (with 0x prefix = 66 chars).
 */
export function isValidAztecAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(address);
}

/**
 * Validate a CAIP-2 network identifier for Aztec.
 */
export function isAztecNetwork(network: string): boolean {
  return /^aztec:.+$/.test(network);
}
