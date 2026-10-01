# @galactica-net/x402-agent

Agent CLI and wallet for private [x402](https://www.x402.org) payments on [Aztec](https://aztec.network). It gives any agent harness that can run shell commands an Aztec wallet, spend-capped payments to x402 endpoints, and a local page where the user funds the agent from their Ethereum wallet.

Part of [aztec-x402](https://github.com/Galactica-corp/aztec-x402). The agent-facing instructions live in the [`aztec-x402` skill](../../plugins/aztec-x402/skills/aztec-x402/SKILL.md).

## Install

```bash
npx -y @galactica-net/x402-agent status      # once published
# from this repo:
bun install && bun run build
cd packages/agent && bun link                # puts `aztec-x402` in ~/.bun/bin
```

Node 22+ (or Bun). Proofs are generated locally; expect 1–3 minutes per paying transaction.

## Commands

| Command | What it does | Time |
| --- | --- | --- |
| `status` | Network, node, wallet address, policy, 24h spend | < 1s |
| `wallet create` / `wallet show` | Create (idempotent) or show the agent's account | < 5s |
| `balance [--token SYM]` | Private balances | seconds |
| `faucet [--token SYM] [--amount N]` | Mint testnet USDC privately to the agent | ~1 min |
| `inspect <url>` | Price of a URL, without paying | < 1s |
| `pay <url> --max-amount N` | Fetch, paying the x402 challenge if within policy | 1–3 min |
| `history [--limit N]` | Local payment ledger | < 1s |
| `fund [--amount N]` | Local page: user signs an L1 deposit, agent claims it | until claimed |
| `fund claim` | Finish pending deposits | minutes |
| `config get` / `config set <key> <value>` | `network`, `nodeUrl`, `policy.maxPerPayment`, `policy.dailyLimit` | < 1s |

Every command prints one JSON document on stdout (`"ok": true|false`) and progress on stderr. Exit codes: 0 ok, 1 error, 2 usage, 3 refused by the spend policy.

## Spend policy

A payment happens only when the 402 challenge passes every check, in the CLI rather than in the prompt:

- the network and token are known (registry or `config.json`);
- price ≤ `--max-amount` (required on every `pay`);
- price ≤ `policy.maxPerPayment` (default 1);
- 24h spend including this payment ≤ `policy.dailyLimit` (default 5);
- optional `--expect-asset` / `--expect-pay-to` pins.

The check runs before the merchant is asked to prepare a commitment and again right before the transfer is proven. Every payment is recorded in `payments.jsonl` as `pending`, then `paid` with its tx hash, or `failed`.

## Files

`~/.aztec-x402` (override with `AZTEC_X402_HOME`):

```
config.json                 network, policy, extra tokens
<network>/account.json      account keys, mode 0600
<network>/pxe/              private state (notes, synced blocks)
<network>/payments.jsonl    payment ledger
<network>/deposits.json     pending deposits with claim secrets, mode 0600
<network>/downloads/        large or binary paid responses
```

## Funding page

`aztec-x402 fund` starts a server on `127.0.0.1` with a per-run token in the URL. The page connects to the user's browser wallet over EIP-1193 and asks it to sign transactions whose calldata the CLI prepared; the claim secret never leaves the CLI. After the L1 deposit, the CLI waits for the L1→L2 message and proves the claim on Aztec.

Routes are bridge adapters (`src/fund/bridge.ts`). On Aztec 5 testnet the live route is the Fee Juice portal on Sepolia: the user gets test FEE from the public faucet, approves, and deposits; the agent receives Fee Juice for its own gas. A stablecoin adapter (USDC via the inference-money bridge) is the planned route for the Aztec 6 testnet.

## Library

`@galactica-net/x402-agent/aztec` exports the payer-side building blocks shared with the demo: `createPXEWallet` (a PXE wallet whose simulations match what it sends, required by the commitment flow), `RealClientAztecSigner`, and session helpers.

## Maintenance

`bun run scripts/deploy-canonical.ts [--network testnet]` checks (and if needed deploys) the canonical Dripper and USDC token that `src/networks.ts` points at.
