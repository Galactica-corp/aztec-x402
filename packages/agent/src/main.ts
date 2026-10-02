import { parseArgs } from "util";
import { resolveContext } from "./config.js";
import { CliError, PolicyError, UsageError, isProverError, messageOf, proverFailed } from "./errors.js";
import { inflightPayment, setInflightPayment } from "./inflight.js";
import { appendLedger } from "./policy.js";
import { hasPrinted, printJson, resetOutput, setQuiet } from "./output.js";
import { walletCreate, walletShow } from "./commands/wallet.js";
import { balance, faucet } from "./commands/balance.js";
import { inspect, pay } from "./commands/pay.js";
import { configGet, configSet, history, status } from "./commands/status.js";
import { fund, fundClaim } from "./commands/fund.js";

export const HELP = `aztec-x402 — private x402 payments on Aztec for agents

Usage: aztec-x402 <command> [options]

Commands:
  status                      Network, node, wallet, policy (fast, no sync)
  wallet create               Create the agent's Aztec account (idempotent)
  wallet show                 Print the agent's address
  balance [--token SYM]       Private token balances
  faucet [--token SYM] [--amount N]
                              Mint testnet tokens to the agent (testnet only)
  inspect <url>               Show what a URL costs, without paying
  pay <url> --max-amount N    Fetch a URL, paying its x402 challenge privately
        [--expect-asset SYM|ADDR] [--expect-pay-to ADDR]
        [-X METHOD] [-d BODY] [-H "Name: value"]... [-o FILE]
  history [--limit N]         Recent payments from the local ledger
  fund [--amount N] [--port P] [--host H] [--no-open]
                              Serve a local page where the user signs an L1
                              deposit to the agent; waits until it is claimed
  fund --hosted [--no-wait]   Same, via a link to the hosted page (for a user
                              browser that cannot reach this machine)
  fund claim                  Finish deposits left pending
  config get | set <key> <value>
                              Keys: network, nodeUrl, policy.maxPerPayment,
                              policy.dailyLimit

Global options:
  --network NAME              testnet (default) or local
  --quiet                     No progress lines on stderr
  --verbose                   Aztec SDK logs on stderr
  -h, --help                  This help

Output: one JSON document on stdout, {"ok": true, ...} or
{"ok": false, "error": {"code", "message"}}. Exit codes: 0 ok, 1 error,
2 usage, 3 refused by spend policy.
`;

const OPTIONS = {
  network: { type: "string" },
  quiet: { type: "boolean" },
  verbose: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  token: { type: "string" },
  amount: { type: "string" },
  "max-amount": { type: "string" },
  "expect-asset": { type: "string" },
  "expect-pay-to": { type: "string" },
  method: { type: "string", short: "X" },
  data: { type: "string", short: "d" },
  header: { type: "string", short: "H", multiple: true },
  output: { type: "string", short: "o" },
  limit: { type: "string" },
  port: { type: "string" },
  host: { type: "string" },
  "no-open": { type: "boolean" },
  hosted: { type: "boolean" },
  "no-wait": { type: "boolean" },
} as const;

async function run(argv: string[]): Promise<object> {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  setQuiet(Boolean(values.quiet));
  const [command, sub, ...rest] = positionals;
  if (values.help || !command || command === "help") return { help: HELP };

  // `config` works without resolving a network (it may be fixing a bad one).
  if (command === "config") {
    if (sub === "set") {
      const [key, value] = rest;
      if (!key || value === undefined) throw new UsageError("Usage: aztec-x402 config set <key> <value>");
      return configSet(key, value);
    }
    if (sub === undefined || sub === "get") return configGet();
    throw new UsageError(`Unknown config subcommand "${sub}"`);
  }

  const ctx = resolveContext(values.network);
  const request = { method: values.method, data: values.data, headers: values.header };

  switch (command) {
    case "status":
      return status(ctx);
    case "wallet":
      if (sub === "create") return walletCreate(ctx);
      if (sub === "show" || sub === undefined) return walletShow(ctx);
      throw new UsageError(`Unknown wallet subcommand "${sub}". Use create or show.`);
    case "balance":
      return balance(ctx, { token: values.token });
    case "faucet":
      return faucet(ctx, { token: values.token, amount: values.amount });
    case "inspect":
      if (!sub) throw new UsageError("Usage: aztec-x402 inspect <url>");
      return inspect(ctx, sub, request);
    case "pay": {
      if (!sub) throw new UsageError("Usage: aztec-x402 pay <url> --max-amount N");
      const maxAmount = values["max-amount"];
      if (!maxAmount) {
        throw new UsageError("--max-amount is required: the most you are willing to pay for this request");
      }
      return pay(ctx, sub, {
        ...request,
        maxAmount,
        expectAsset: values["expect-asset"],
        expectPayTo: values["expect-pay-to"],
        output: values.output,
      });
    }
    case "history":
      return history(ctx, { limit: values.limit ? Number(values.limit) : undefined });
    case "fund":
      if (sub === "claim") return fundClaim(ctx);
      if (sub !== undefined) throw new UsageError(`Unknown fund subcommand "${sub}"`);
      return fund(ctx, {
        host: values.host,
        amount: values.amount,
        port: values.port ? Number(values.port) : undefined,
        open: !values["no-open"],
        hosted: Boolean(values.hosted),
        wait: !values["no-wait"],
      });
    default:
      throw new UsageError(`Unknown command "${command}". Run \`aztec-x402 --help\`.`);
  }
}

export async function main(argv: string[]): Promise<number> {
  resetOutput();
  try {
    const result = await run(argv);
    if ("help" in result) {
      process.stdout.write(HELP);
      return 0;
    }
    printJson({ ok: true, ...result });
    return 0;
  } catch (error) {
    return reportError(error);
  }
}

/**
 * Turn any failure into the one JSON document on stdout. Also used for
 * errors that escape the command (uncaught exceptions from SDK callbacks),
 * which must keep the `ok: false` + `error.code` contract too.
 */
export function reportError(thrown: unknown): number {
  const payment = inflightPayment();
  if (payment) {
    // Proving precedes sending: a prover failure means no tx; anything else may have sent one.
    appendLedger(payment.dataDir, {
      id: payment.id,
      status: isProverError(thrown) ? "failed" : "uncertain",
      error: messageOf(thrown),
    });
    setInflightPayment(undefined);
  }
  const error = isProverError(thrown) ? proverFailed(thrown) : thrown;
  if (hasPrinted()) {
    process.stderr.write(`[aztec-x402] error after output: ${messageOf(error)}\n`);
    return 1;
  }
  if (error instanceof CliError) {
    printJson({ ok: false, error: { code: error.code, message: error.message, ...error.details } });
    if (error instanceof PolicyError) return 3;
    return error instanceof UsageError ? 2 : 1;
  }
  // parseArgs throws TypeErrors with ERR_PARSE_ARGS_* codes for bad flags.
  const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
  if (error instanceof Error && typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
    printJson({ ok: false, error: { code: "usage", message: error.message } });
    return 2;
  }
  printJson({ ok: false, error: { code: "unexpected", message: messageOf(error) } });
  if (process.env.LOG_LEVEL !== "silent" && error instanceof Error) console.error(error.stack);
  return 1;
}
