# Private x402 for any agent: the `aztec-x402` skill

The FireFlow demo shows one agent paying privately with x402 on Aztec. This skill opens the same rail to any agent harness that can run shell commands — Claude Code first, then Codex, Gemini CLI, Hermes, and others that read [Agent Skills](https://agentskills.io).

It has two parts:

| Part | Where | Role |
| --- | --- | --- |
| Skill | [`plugins/aztec-x402/skills/aztec-x402/`](../plugins/aztec-x402/skills/aztec-x402/SKILL.md) | Tells the agent when and how to pay, and the guardrails. Reference files cover the protocol, addresses, funding, and errors. |
| CLI | [`packages/agent`](../packages/agent/README.md) (`aztec-x402`) | Wallet, balances, faucet, price checks, payments, and the funding page. The spend policy lives here, not in the prompt. |

The CLI wraps the same libraries as the FireFlow nodes (`@galactica-net/x402-client`, `-mechanism`, the PXE wallet). The agent never builds transactions itself.

---

## Install

### Claude Code

```text
/plugin marketplace add Galactica-corp/aztec-x402
/plugin install aztec-x402@galactica-x402
```

### Other harnesses

The skill folder is plain Agent Skills format (`SKILL.md` plus `references/`). Copy `plugins/aztec-x402/skills/aztec-x402/` into the harness's skills directory as its docs describe. Harnesses without skill support can take `SKILL.md` as a system-prompt section; the reference links are relative paths the agent can read on demand.

### The CLI

Until `@galactica-net/x402-agent` is on npm, build it from this repo:

```bash
bun install && bun run build
cd packages/agent && bun link        # `aztec-x402` on PATH via ~/.bun/bin
aztec-x402 status
```

---

## Demo script (Aztec testnet)

Prerequisite: a merchant to buy from. The reference merchant charges 0.01 testnet USDC per resource:

```bash
bun run setup:usdc     # once: merchant accounts on testnet, using the canonical testnet USDC
bun run server         # http://localhost:4402
```

Then talk to the agent:

1. **"Set yourself up to pay for things privately."** The agent runs `status`, creates its Aztec wallet, and reports the address. No transaction needed.
2. **"Get some test money."** The agent runs `faucet` and mints 10 private USDC (about a minute — a proof is generated locally).
3. **"Buy me the x402 achievement at http://localhost:4402/api/buy-x402-achievement — up to 5 cents."** The agent checks the price (0.01 USDC), pays with `--max-amount 0.05`, and returns the achievement skill with the Aztec tx hash. About 2 minutes.
4. **Guardrail moment: "Now buy it again, but don't spend more than half a cent."** The CLI refuses before any money moves (exit 3, `policy_rejected`), and the agent asks you instead of raising the cap.
5. **"Help me fund you from my own wallet."** The agent serves a local page — or, when it runs somewhere your browser cannot reach, sends a link to the hosted page at `aztec-x402.unfz.to`. Connect MetaMask on Sepolia (a little Sepolia ETH for gas), sign the planned transactions, and the agent finds the deposit on L1 and claims it on Aztec a few minutes later.

What the audience should notice: the agent pays an HTTP API in a private stablecoin without a human in the loop, the explorer shows no sender, recipient, or amount, and the spend cap is enforced by the tool, not by trusting the model.

---

## Tested with

Fresh agent wallet, plain request ("buy me the x402 achievement at … up to 5 cents") with no mention of the skill, against the reference merchant on Aztec testnet:

| Harness | Model | Skill found on its own | Result |
| --- | --- | --- | --- |
| Claude Code 2.1 (plugin from this marketplace) | Sonnet 5.5 | yes | wallet → faucet → `pay --max-amount 0.05 --expect-pay-to …`, paid 0.01 USDC, ~4 min |
| Claude Code 2.1 | Opus 5.5 | yes | triggered and followed the same steps (run stopped before paying) |
| Codex CLI 0.155 (`~/.codex/skills/aztec-x402`, workspace-write sandbox with network) | Codex default | yes | wallet → faucet → `pay`, paid 0.01 USDC |

Funding from a phone ("fund you from my MetaMask; I'm on my phone and can't open anything on your machine"):

| Harness | Model | Result |
| --- | --- | --- |
| Claude Code 2.1 | Sonnet 5.5 | chose `fund --hosted`, handed over the link, explained gas-not-USDC, gas needs, and the address check |
| Codex CLI 0.155 | Codex default | chose `fund --hosted --no-wait` (no persistent process), same explanation |

The hosted page's plan was also run through `eth_simulateV1` against the live Sepolia contracts (mint → approve → deposit all succeed, the deposit event names the agent and the CLI's secret hash), and the CLI's L1 watcher found a real Sepolia deposit by recipient and secret hash.

## What is live and what is next

| Capability | Status |
| --- | --- |
| Agent wallet (initializerless Schnorr, no deploy tx) | Live on testnet |
| Testnet USDC faucet (canonical `aztec-standards` USDC + Dripper) | Live on testnet |
| Price check, spend-capped private payment, payment ledger | Live on testnet |
| Funding page with browser wallet; agent claims on Aztec | Live on testnet via the **Fee Juice** portal (agent gas); local page or hosted link (`aztec-x402.unfz.to/fund.html`) for agents the user cannot reach |
| Funding the agent with **USDC from Ethereum** | Next: Aztec 6 testnet, using the inference-money USDC bridge (Circle Sepolia USDC → private AIP-20 USDC, one Permit2 signature). Needs the x402 stack on Aztec 6. |
| Published npm package and Claude Code marketplace entry | After review of this branch |
| Mainnet | Not yet; the network registry has a slot for it. |

## Design notes

- **Why a CLI and not raw Aztec calls.** A payment is a three-round HTTP exchange around a locally proven private transfer, plus note discovery. Agents follow one command reliably; they do not reliably assemble that sequence. The CLI prints one JSON document per command so any harness can parse it.
- **Why the policy sits in the CLI.** Skills are instructions; a model can misread them. The cap the user approves is a required flag, and the per-payment and 24h limits are enforced before the merchant prepares and again right before the transfer is proven.
- **Why TypeScript.** Aztec's private execution and proving run in the TypeScript SDK with a WASM/native prover. There is no Go or Rust client SDK to compile against.
- **Keys.** One account per agent home, in a 0600 file. The skill instructs the agent to keep that file out of the conversation. Losing it loses the funds; there is no recovery yet.
- **Deposit secrets.** For L1 → Aztec deposits the CLI generates the claim secret and only its hash reaches the page and the L1 transaction.
