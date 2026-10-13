# Error codes

Every failure prints `{"ok": false, "error": {"code": …, "message": …}}`. Find the code below.

| `error.code` | Money moved? | What to do |
| --- | --- | --- |
| `no_wallet` | no | `aztec-x402 wallet create`. |
| `node_unreachable` | no | The Aztec node did not answer (`error.nodeUrl`). Check network access; `aztec-x402 status` shows `node.reachable`. Retry after a minute. |
| `node_version` | no | The node answered, but `error.nodeVersion` is not Aztec 6.x (`error.expectedMajor`). A `nodeUrl` saved before the v6 upgrade still points at the old rollup. Set a 6.x node with `aztec-x402 config set nodeUrl <url>` or `AZTEC_X402_NODE_URL`. |
| `prover_failed` | no (`txSubmitted: false`) | Proof generation failed before anything was sent. On first use the prover downloads its parameters (CRS, ~15 MB) into `~/.bb-crs`: it needs network access to fetch them and a writable home directory. Fix that and retry; a `pay` that fails here can be retried safely. |
| `usage` | no | Fix the command; `aztec-x402 --help`. |
| `policy_rejected` (exit 3) | no | Price above `--max-amount`, the per-payment limit, or the 24h limit, or an unexpected token / merchant. Report the message and ask the user. |
| `not_x402` | no | The URL answers 402 without an x402 header — it uses another payment system. Tell the user. |
| `no_matching_option` | no | The merchant does not accept payment on this network or scheme. `error.options` lists what it does accept. |
| `unknown_token` / `token_not_found` | no | Token not in the registry or not deployed on this network. See networks.md to add one. |
| `unsupported_token` | no | The address is a contract, but not one of the supported token kinds. Do not pay; tell the user. |
| `merchant_not_listed` | no | The token (inference-money `USDC`) only pays merchants on its list, and this payee is not on it. Nothing to retry: tell the user the merchant cannot be paid in this token. |
| `payment_refused` | no, not by this attempt | This payment request was already paid or is being paid (`error.reason`; `error.txHash` if known). Do not pay again: check `history`, then ask the merchant for the content or request the URL afresh. |
| `token_refused` | no | The token contract's own rules refused the call (`error.rule`). Report the message. |
| `prepare_failed` | no | The merchant could not create the commitment (its own tx failed or the nonce expired). Retry once; then report the merchant's message. |
| `not_delivered` | **yes** | Paid, content not returned. `error.payment.txHash` is the proof of payment. Give it to the user; ask before paying again. |
| `payment_uncertain` | maybe | The transfer was sent or about to be, but not confirmed in time. It still counts toward the 24h limit. Check `aztec-x402 balance` against the price; ask the user before retrying. |
| `no_faucet` | no | No faucet for that token on this network. Fund via `aztec-x402 fund`. |
| `insufficient_l1_balance` | no | The user's L1 wallet lacks the deposit token and there is no faucet for it. |
| `message_timeout` | deposit on L1, not yet claimed | `aztec-x402 fund claim` later. |
| `fund_timeout` | no claim | No deposit seen on L1 within 60 minutes. If the user sent one later, `fund claim` finds it; otherwise start `fund` again. |
| `unexpected` | check `history` | Read the message. Common cases below. |

## Common `unexpected` messages

- **Insufficient balance / "Balance too low"** during `pay` — the private balance is below the price. `aztec-x402 balance`, then fund.
- **Lock or "already processing" errors** — two wallet commands ran at once. Run them one at a time.

When unsure whether a payment went out, `aztec-x402 history` shows each payment as `pending`, `paid` (with `txHash`), `uncertain`, or `failed`. A `paid` entry is the record to show the user. Add `--verbose` to any command for the Aztec SDK logs on stderr.
