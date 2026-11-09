/**
 * Reading x402 challenges from HTTP responses, independent of any wallet.
 */
import { PaymentRequiredSchema, type ParsedPaymentRequirements } from "@galactica-net/x402-mechanism";
import { SCHEME, formatAmount, parseAztecPaymentExtra, type PaymentMode } from "@galactica-net/x402-core";
import type { NetworkConfig, TokenInfo } from "./networks.js";
import { findToken } from "./config.js";

export interface DecodedChallenge {
  x402Version: number;
  error?: string;
  description?: string;
  accepts: ParsedPaymentRequirements[];
}

/** Decode the base64 `PAYMENT-REQUIRED` header of a 402 response. */
export function decodePaymentRequired(response: Response): DecodedChallenge | undefined {
  const header = response.headers.get("PAYMENT-REQUIRED");
  if (!header) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(header, "base64").toString());
  } catch {
    return undefined;
  }
  const parsed = PaymentRequiredSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const extra = typeof raw === "object" && raw !== null ? raw : {};
  const error = Reflect.get(extra, "error");
  const resource = Reflect.get(extra, "resource");
  const description = typeof resource === "object" && resource !== null ? Reflect.get(resource, "description") : undefined;
  return {
    ...parsed.data,
    error: typeof error === "string" ? error : undefined,
    description: typeof description === "string" ? description : undefined,
  };
}

/** The payment mode of an `accepts` entry: `commitment` when it names none (servers before modes existed). */
export function modeOf(req: { extra?: Record<string, unknown> }): PaymentMode {
  try {
    return parseAztecPaymentExtra(req.extra).mode ?? "commitment";
  } catch {
    return "commitment";
  }
}

/** The requirement this agent can pay: our scheme on our network. */
export function selectRequirement(
  challenge: DecodedChallenge,
  network: NetworkConfig,
): ParsedPaymentRequirements | undefined {
  return challenge.accepts.find((a) => a.scheme === SCHEME && a.network === network.caip2);
}

export interface PriceView {
  scheme: string;
  network: string;
  asset: string;
  token?: string;
  /** Human-readable amount, when the token is known. */
  amount?: string;
  amountBaseUnits: string;
  payTo: string;
  maxTimeoutSeconds: number;
  /** `ref` (private amount), `split` (pay from Ethereum) or `commitment`. */
  mode: PaymentMode;
  payable: boolean;
  reason?: string;
}

export function describeRequirement(req: ParsedPaymentRequirements, network: NetworkConfig): PriceView {
  const token = findToken(network, req.asset);
  let reason: string | undefined;
  if (req.scheme !== SCHEME) reason = `unsupported scheme "${req.scheme}"`;
  else if (req.network !== network.caip2) reason = `challenge is for ${req.network}, agent is on ${network.caip2}`;
  else if (!token) reason = `unknown asset ${req.asset} (not in the token registry)`;
  return {
    scheme: req.scheme,
    network: req.network,
    asset: req.asset,
    token: token?.symbol,
    amount: token ? trimAmount(formatAmount(BigInt(req.amount), token.decimals)) : undefined,
    amountBaseUnits: req.amount,
    payTo: req.payTo,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
    mode: modeOf(req),
    payable: reason === undefined,
    reason,
  };
}

/** "0.010000" → "0.01", "5.000000" → "5" */
export function trimAmount(amount: string): string {
  return amount.includes(".") ? amount.replace(/0+$/, "").replace(/\.$/, "") : amount;
}

export function formatTokenAmount(amount: bigint, token: TokenInfo): string {
  return trimAmount(formatAmount(amount, token.decimals));
}
