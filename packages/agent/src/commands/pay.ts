/**
 * `inspect` reads a URL's price without paying; `pay` fetches it, paying the
 * x402 challenge privately if the spend policy allows.
 *
 * Pay flow:
 *   1. Plain request. Not 402 → return the response, nothing paid.
 *   2. Policy check on the 402 challenge — before the merchant is asked to
 *      prepare (prepare is an on-chain tx the merchant pays for).
 *   3. wrapFetchWithPayment runs prepare → transfer_private_to_commitment →
 *      retry with PAYMENT-SIGNATURE. The prepared challenge is re-checked
 *      right before any money moves.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { wrapFetchWithPayment } from "@galactica-net/x402-client";
import { ExactAztecClientScheme } from "@galactica-net/x402-mechanism/exact/client";
import type { PaymentRequirements, SchemeNetworkClient } from "@galactica-net/x402-mechanism";
import { SCHEME, parseAztecPaymentExtra } from "@galactica-net/x402-core";
import { RealClientAztecSigner } from "../aztec/client-signer.js";
import { openSession, tokenAt } from "../aztec/session.js";
import { sameAddress, type ResolvedContext } from "../config.js";
import { CliError, PolicyError, UsageError } from "../errors.js";
import { appendLedger, checkPayment, type PaymentLimits } from "../policy.js";
import { decodePaymentRequired, describeRequirement, formatTokenAmount, selectRequirement } from "../x402.js";
import { progress } from "../output.js";

export interface RequestOptions {
  method?: string;
  data?: string;
  headers?: string[];
}

/** Bodies up to this size are returned inline; larger ones are saved to a file. */
const INLINE_BODY_LIMIT = 64 * 1024;

function buildInit(opts: RequestOptions): RequestInit {
  const headers: Record<string, string> = {};
  for (const h of opts.headers ?? []) {
    const i = h.indexOf(":");
    if (i <= 0) throw new UsageError(`Header must look like "Name: value", got "${h}"`);
    headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  if (opts.data !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json";
  }
  return {
    method: opts.method ?? (opts.data !== undefined ? "POST" : "GET"),
    headers,
    body: opts.data,
  };
}

function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`Not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UsageError(`Only http(s) URLs are supported, got ${parsed.protocol}`);
  }
}

export async function inspect(ctx: ResolvedContext, url: string, opts: RequestOptions) {
  validateUrl(url);
  const response = await fetch(url, buildInit(opts));
  if (response.status !== 402) {
    return { url, status: response.status, paymentRequired: false };
  }
  const challenge = decodePaymentRequired(response);
  if (!challenge) {
    return { url, status: 402, paymentRequired: true, x402: false, note: "402 without an x402 PAYMENT-REQUIRED header" };
  }
  return {
    url,
    status: 402,
    paymentRequired: true,
    x402: true,
    description: challenge.description,
    agentNetwork: ctx.network.caip2,
    options: challenge.accepts.map((a) => describeRequirement(a, ctx.network)),
  };
}

async function readBody(response: Response, dataDir: string, id: string, output?: string) {
  const contentType = response.headers.get("content-type") ?? "";
  const bytes = Buffer.from(await response.arrayBuffer());
  const isText = /^(text\/|application\/(json|xml|javascript|x-ndjson))|\+json|\+xml|markdown/.test(contentType);

  if (output || !isText || bytes.length > INLINE_BODY_LIMIT) {
    const path = output ?? join(dataDir, "downloads", `${id}${extensionFor(contentType)}`);
    if (!output) mkdirSync(join(dataDir, "downloads"), { recursive: true });
    writeFileSync(path, bytes);
    return { contentType, bytes: bytes.length, savedTo: path };
  }
  const text = bytes.toString("utf-8");
  if (contentType.includes("json")) {
    try {
      return { contentType, body: JSON.parse(text) };
    } catch {
      // fall through to raw text
    }
  }
  return { contentType, body: text };
}

function extensionFor(contentType: string): string {
  if (contentType.includes("json")) return ".json";
  if (contentType.includes("markdown")) return ".md";
  if (contentType.startsWith("text/")) return ".txt";
  return ".bin";
}

export async function pay(
  ctx: ResolvedContext,
  url: string,
  opts: RequestOptions & PaymentLimits & { output?: string },
) {
  validateUrl(url);
  const init = buildInit(opts);
  const id = crypto.randomUUID();

  progress(`Requesting ${url}...`);
  const first = await fetch(url, init);
  if (first.status !== 402) {
    return { url, status: first.status, paid: false, ...(await readBody(first, ctx.dataDir, id, opts.output)) };
  }

  const challenge = decodePaymentRequired(first);
  if (!challenge) {
    throw new CliError("Server answered 402 but sent no x402 PAYMENT-REQUIRED header", "not_x402");
  }
  const requirement = selectRequirement(challenge, ctx.network);
  if (!requirement) {
    throw new CliError(
      `No payment option for ${ctx.network.caip2} with scheme "${SCHEME}"`,
      "no_matching_option",
      { options: challenge.accepts.map((a) => describeRequirement(a, ctx.network)) },
    );
  }
  // Refuse before the merchant spends a prepare tx on us.
  const token = checkPayment(requirement, opts, ctx.policy, ctx.network, ctx.dataDir);
  const price = formatTokenAmount(BigInt(requirement.amount), token);
  progress(`Price: ${price} ${token.symbol} to ${requirement.payTo} — within policy.`);

  progress("Opening wallet and syncing private state...");
  const session = await openSession(ctx.network, ctx.dataDir);
  const tokenContract = await tokenAt(session, token.address);
  const signer = new RealClientAztecSigner(session.account, tokenContract, { fee: session.fee });
  const inner = new ExactAztecClientScheme(signer);

  let txHash: string | undefined;
  let nonce: string | undefined;
  const guarded: SchemeNetworkClient = {
    scheme: inner.scheme,
    getSenderAddress: () => inner.getSenderAddress(),
    async createPaymentPayload(x402Version: number, prepared: PaymentRequirements) {
      // The prepared challenge must be the one we approved, and still within policy.
      if (
        prepared.amount !== requirement.amount ||
        !sameAddress(prepared.asset, requirement.asset) ||
        !sameAddress(prepared.payTo, requirement.payTo)
      ) {
        throw new PolicyError("Prepared challenge differs from the original 402 challenge");
      }
      checkPayment(prepared, opts, ctx.policy, ctx.network, ctx.dataDir);
      nonce = parseAztecPaymentExtra(prepared.extra).nonce;
      appendLedger(ctx.dataDir, {
        id,
        status: "pending",
        url,
        network: ctx.network.caip2,
        asset: token.address,
        token: token.symbol,
        amount: price,
        amountBaseUnits: requirement.amount,
        payTo: requirement.payTo,
        nonce,
      });
      progress("Merchant prepared the commitment. Proving private transfer (takes ~30-90s)...");
      try {
        const result = await inner.createPaymentPayload(x402Version, prepared);
        const hash = result.payload.txHash;
        txHash = typeof hash === "string" ? hash : undefined;
        appendLedger(ctx.dataDir, { id, status: "paid", txHash });
        progress(`Paid in tx ${txHash}. Sending proof to merchant...`);
        return result;
      } catch (error) {
        // A timeout can hit after the tx was sent; keep counting it against the budget.
        const message = String(error);
        const uncertain = /time(d)?\s?out/i.test(message);
        appendLedger(ctx.dataDir, { id, status: uncertain ? "uncertain" : "failed", error: message });
        if (uncertain) {
          throw new CliError(
            "The transfer may have been sent but was not confirmed in time. Check `aztec-x402 balance` before retrying.",
            "payment_uncertain",
          );
        }
        throw error;
      }
    },
  };

  // Hand the already-received first 402 back to the wrapper instead of re-requesting.
  let firstServed = false;
  const fetchOnce: typeof fetch = async (input, reqInit) => {
    if (!firstServed) {
      firstServed = true;
      return first;
    }
    return fetch(input, reqInit);
  };
  const payFetch = wrapFetchWithPayment(fetchOnce, guarded);
  const response = await payFetch(url, init);

  if (!txHash) {
    const rejected = decodePaymentRequired(response);
    throw new CliError(
      `Payment was not started: ${rejected?.error ?? `server answered ${response.status} during prepare`}`,
      "prepare_failed",
      { status: response.status },
    );
  }

  const payment = {
    token: token.symbol,
    amount: price,
    payTo: requirement.payTo,
    txHash,
    nonce,
  };
  if (!response.ok) {
    const rejected = decodePaymentRequired(response);
    appendLedger(ctx.dataDir, { id, status: "paid", error: rejected?.error ?? `HTTP ${response.status}` });
    throw new CliError(
      `Paid, but the merchant did not deliver: ${rejected?.error ?? `HTTP ${response.status}`}`,
      "not_delivered",
      { status: response.status, payment },
    );
  }

  return {
    url,
    status: response.status,
    paid: true,
    payment,
    ...(await readBody(response, ctx.dataDir, id, opts.output)),
  };
}
