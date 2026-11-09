/**
 * `inspect` reads a URL's price without paying; `pay` fetches it, paying the
 * x402 challenge privately if the spend policy allows.
 *
 * Pay flow:
 *   1. Plain request. Not 402 → return the response, nothing paid.
 *   2. Policy check on the 402 challenge, then the token's own rules (e.g.
 *      the payee must be a listed merchant).
 *   3. When the merchant offers `ref` and the token can pay it: a private
 *      transfer under the merchant's reference (pay_private). Its proof is
 *      stored before it is sent and resent unchanged until the merchant
 *      answers 2xx (`pay --resume <id>` after a crash or a lost response).
 *   4. Otherwise the commitment flow, checked before the merchant is asked to
 *      prepare (prepare is an on-chain tx the merchant pays for):
 *      wrapFetchWithPayment runs prepare → transfer_private_to_commitment →
 *      retry with PAYMENT-SIGNATURE. The client binds the prepare response to
 *      the 402 it parsed. This command also checks that those terms are the
 *      requirement it approved and will record, then re-checks spend policy
 *      right before any money moves.
 *   `--from-ethereum` pays the `split` offer instead (pay-split.ts).
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { PaymentTermsMismatchError, sendPayment, wrapFetchWithPayment } from "@galactica-net/x402-client";
import { ExactAztecClientScheme } from "@galactica-net/x402-mechanism/exact/client";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkClient } from "@galactica-net/x402-mechanism";
import { SCHEME, parseAztecPaymentExtra } from "@galactica-net/x402-core";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { RealClientAztecSigner } from "../aztec/client-signer.js";
import { openSession, tokenAt } from "../aztec/session.js";
import { sameAddress, type ResolvedContext } from "../config.js";
import { CliError, PolicyError, UsageError, isProverError, proverFailed } from "../errors.js";
import { setInflightPayment } from "../inflight.js";
import { appendLedger, checkPayment, type PaymentLimits } from "../policy.js";
import { decodePaymentRequired, describeRequirement, formatTokenAmount, modeOf } from "../x402.js";
import { acknowledgeStoredPayment, readStoredPayment, saveStoredPayment } from "../proofs.js";
import type { TokenInfo } from "../networks.js";
import { paySplit, resumeSplit } from "./pay-split.js";
import { progress } from "../output.js";

export interface RequestOptions {
  method?: string;
  data?: string;
  headers?: string[];
}

/** Bodies up to this size are returned inline; larger ones are saved to a file. */
const INLINE_BODY_LIMIT = 64 * 1024;

export interface SerializedRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export function buildInit(opts: RequestOptions): SerializedRequest {
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

export function validateUrl(url: string): void {
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

export async function readBody(response: Response, dataDir: string, id: string, output?: string) {
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

export interface PayOptions extends RequestOptions, PaymentLimits {
  output?: string;
  /** Pay the merchant's `split` offer: one deposit the user signs on Ethereum. */
  fromEthereum?: boolean;
  /** Split only: the deposit amount in USDC (one of the offered round amounts). */
  deposit?: string;
  /** Split, hosted page only: print the link and return; `pay --resume` finishes it. */
  hosted?: boolean;
  wait?: boolean;
  open?: boolean;
  port?: number;
  host?: string;
}

/** Resends ref/split payments while the merchant says the payment may verify later (not mined, not deep enough). */
export const DELIVERY_RETRY = { attempts: 40, delayMs: 6_000 };

export async function pay(ctx: ResolvedContext, url: string, opts: PayOptions) {
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
  const entries = challenge.accepts.filter((a) => a.scheme === SCHEME && a.network === ctx.network.caip2);
  if (entries.length === 0) {
    throw new CliError(
      `No payment option for ${ctx.network.caip2} with scheme "${SCHEME}"`,
      "no_matching_option",
      { options: challenge.accepts.map((a) => describeRequirement(a, ctx.network)) },
    );
  }

  if (opts.fromEthereum) {
    const split = entries.find((a) => modeOf(a) === "split");
    if (!split) throw new CliError("The merchant does not offer payment from Ethereum (split) for this resource.", "no_split_option");
    return paySplit(ctx, { id, url, init, accepted: split, x402Version: challenge.x402Version, opts });
  }

  const ref = entries.find((a) => modeOf(a) === "ref");
  const commitment = entries.find((a) => modeOf(a) === "commitment");
  const requirement = ref ?? commitment ?? entries[0];
  if (!requirement) throw new CliError("No payable option", "no_matching_option");
  // Refuse before anything moves (and before a merchant spends a prepare tx on us).
  const token = checkPayment(requirement, opts, ctx.policy, ctx.network, ctx.dataDir);
  const price = formatTokenAmount(BigInt(requirement.amount), token);
  progress(`Price: ${price} ${token.symbol} to ${requirement.payTo} — within policy.`);

  progress("Opening wallet and syncing private state...");
  const session = await openSession(ctx.network, ctx.dataDir, { payingWith: token.address });
  // Refuse what the token's own rules would, also before the merchant prepares.
  const adapter = await tokenAt(session, token.address);
  await adapter.preflight(AztecAddress.fromStringUnsafe(requirement.payTo));
  const signer = new RealClientAztecSigner(session.account, session.tokens);

  if (ref && adapter.payPrivate) {
    return payRef(ctx, { id, url, init, accepted: ref, x402Version: challenge.x402Version, token, price, signer, opts });
  }
  if (!commitment) {
    throw new CliError(
      `The merchant offers ${entries.map((e) => modeOf(e)).join(", ")}; this agent cannot pay any of them in ${token.symbol}.`,
      "no_matching_option",
    );
  }
  return payCommitment(ctx, { id, url, init, first, requirement: commitment, token, price, signer, opts });
}

interface RefPayment {
  id: string;
  url: string;
  init: SerializedRequest;
  accepted: PaymentRequirements;
  x402Version: number;
  token: TokenInfo;
  price: string;
  signer: RealClientAztecSigner;
  opts: PayOptions;
}

/** A private transfer under the merchant's reference; the proof is stored before it goes anywhere. */
async function payRef(ctx: ResolvedContext, p: RefPayment) {
  const { id, url, accepted, token } = p;
  const extra = parseAztecPaymentExtra(accepted.extra);
  const paymentRef = extra.paymentRef;
  if (!paymentRef) throw new CliError("The merchant's ref offer has no payment reference", "bad_challenge");
  appendLedger(ctx.dataDir, {
    id,
    status: "pending",
    url,
    network: ctx.network.caip2,
    asset: token.address,
    token: token.symbol,
    amount: p.price,
    amountBaseUnits: accepted.amount,
    payTo: accepted.payTo,
    nonce: extra.nonce,
    mode: "ref",
    paymentRef,
  });
  progress("Proving the private payment (takes ~30-90s)...");
  setInflightPayment({ dataDir: ctx.dataDir, id });
  let payload: PaymentPayload;
  try {
    const proof = await p.signer.payPrivate(accepted.asset, accepted.payTo, BigInt(accepted.amount), paymentRef);
    payload = { x402Version: p.x402Version, accepted, payload: { mode: "ref", ...proof } };
    // First thing after the payment returns: the proof is the only copy of the merchant's note.
    saveStoredPayment(ctx.dataDir, { id, url, request: p.init, payload, createdAt: new Date().toISOString() });
    appendLedger(ctx.dataDir, { id, status: "paid", txHash: proof.txHash });
  } catch (error) {
    throw failedPayment(ctx, id, error);
  } finally {
    setInflightPayment(undefined);
  }
  progress(`Paid in tx ${String(payload.payload.txHash)}. Handing the merchant the payment...`);
  return deliver(ctx, id, url, p.init, payload, { token: token.symbol, amount: p.price, payTo: accepted.payTo }, p.opts.output);
}

/** Ledger and error for a payment that failed or may have failed while proving or sending. */
function failedPayment(ctx: ResolvedContext, id: string, error: unknown): unknown {
  if (isProverError(error)) {
    appendLedger(ctx.dataDir, { id, status: "failed", error: String(error) });
    return proverFailed(error);
  }
  // A timeout can hit after the tx was sent; keep counting it against the budget.
  const message = String(error);
  const uncertain = /time(d)?\s?out/i.test(message);
  appendLedger(ctx.dataDir, { id, status: uncertain ? "uncertain" : "failed", error: message });
  if (uncertain) {
    return new CliError(
      "The transfer may have been sent but was not confirmed in time. Check `aztec-x402 balance` before retrying.",
      "payment_uncertain",
    );
  }
  return error;
}

/**
 * Sends a stored payment and returns the merchant's content. Anything but 2xx
 * leaves the payment stored for `pay --resume <id>`; the same payload is sent
 * every time, so the merchant serves it once.
 */
export async function deliver(
  ctx: ResolvedContext,
  id: string,
  url: string,
  init: SerializedRequest,
  payload: PaymentPayload,
  summary: Record<string, string>,
  output?: string,
) {
  const tx = payload.payload.txHash ?? payload.payload.l1TxHash;
  const payment = { ...summary, mode: modeOf(payload.accepted), txHash: typeof tx === "string" ? tx : undefined, id };
  const resume = `aztec-x402 pay --resume ${id}`;
  let response: Response;
  try {
    response = await sendPayment(fetch, url, init, payload, DELIVERY_RETRY);
  } catch (error) {
    appendLedger(ctx.dataDir, { id, status: "paid", error: String(error) });
    throw new CliError(`Paid, but the merchant did not respond: ${String(error)}. Deliver it again with \`${resume}\`.`, "not_delivered", {
      payment,
      resume,
    });
  }
  if (!response.ok) {
    const rejected = decodePaymentRequired(response);
    const reason = rejected?.error ?? `HTTP ${response.status}`;
    appendLedger(ctx.dataDir, { id, status: "paid", error: reason });
    throw new CliError(`Paid, but the merchant did not deliver: ${reason}. Retry with \`${resume}\`.`, "not_delivered", {
      status: response.status,
      payment,
      resume,
    });
  }
  acknowledgeStoredPayment(ctx.dataDir, id);
  return { url, status: response.status, paid: true, payment, ...(await readBody(response, ctx.dataDir, id, output)) };
}

/** Delivers a stored payment again, unchanged: no new money moves. */
export async function resumePayment(ctx: ResolvedContext, id: string, opts: PayOptions) {
  const split = resumeSplit(ctx, id, opts);
  if (split) return split;
  const stored = readStoredPayment(ctx.dataDir, id);
  if (stored.acknowledgedAt) {
    throw new UsageError(`Payment ${id} was already delivered (${stored.acknowledgedAt}); it is not served twice.`, "already_delivered");
  }
  progress(`Delivering stored payment ${id} to ${stored.url} again...`);
  const accepted = stored.payload.accepted;
  return deliver(ctx, id, stored.url, stored.request, stored.payload, { amountBaseUnits: accepted.amount, payTo: accepted.payTo }, opts.output);
}

interface CommitmentPayment {
  id: string;
  url: string;
  init: SerializedRequest;
  first: Response;
  requirement: PaymentRequirements;
  token: TokenInfo;
  price: string;
  signer: RealClientAztecSigner;
  opts: PayOptions;
}

async function payCommitment(ctx: ResolvedContext, c: CommitmentPayment) {
  const { id, url, init, first, requirement, token, price, opts } = c;
  const inner = new ExactAztecClientScheme(c.signer);

  let txHash: string | undefined;
  let nonce: string | undefined;
  const guarded: SchemeNetworkClient = {
    scheme: inner.scheme,
    getSenderAddress: () => inner.getSenderAddress(),
    // The commitment entry, even when the merchant lists others first.
    selectRequirement: (accepts) => accepts.find((a) => modeOf(a) === "commitment"),
    async createPaymentPayload(x402Version: number, prepared: PaymentRequirements) {
      // The client binds the prepare response to the commitment entry of the
      // 402 it parsed (selectRequirement above). The ledger records `requirement`, the
      // accept this command approved. Refuse a transfer that is not that quote.
      if (
        prepared.amount !== requirement.amount ||
        prepared.network !== requirement.network ||
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
        mode: "commitment",
      });
      progress("Merchant prepared the commitment. Proving private transfer (takes ~30-90s)...");
      setInflightPayment({ dataDir: ctx.dataDir, id });
      try {
        const result = await inner.createPaymentPayload(x402Version, prepared);
        const hash = result.payload.txHash;
        txHash = typeof hash === "string" ? hash : undefined;
        appendLedger(ctx.dataDir, { id, status: "paid", txHash });
        progress(`Paid in tx ${txHash}. Sending proof to merchant...`);
        return result;
      } catch (error) {
        throw failedPayment(ctx, id, error);
      } finally {
        setInflightPayment(undefined);
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
  let response: Response;
  try {
    response = await payFetch(url, init);
  } catch (error) {
    if (!txHash && error instanceof PaymentTermsMismatchError) {
      throw new PolicyError(error.message, {
        field: error.field,
        expected: error.expected,
        actual: error.actual,
      });
    }
    if (!txHash) throw error;
    // Money moved but the merchant never answered the retry with proof.
    appendLedger(ctx.dataDir, { id, status: "paid", error: String(error) });
    throw new CliError(
      `Paid, but the merchant did not respond with the content: ${String(error)}`,
      "not_delivered",
      { payment: { token: token.symbol, amount: price, payTo: requirement.payTo, txHash, nonce } },
    );
  }

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
    mode: "commitment",
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
