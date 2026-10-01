# How a private x402 payment works

x402 turns HTTP 402 Payment Required into a machine-payable invoice. This flavour settles on **Aztec**, a privacy-first Ethereum L2, with **AIP-20** private stablecoin balances. The CLI runs all of it; this page is for explaining it to the user.

## The three HTTP round trips

1. **Challenge.** The client requests the resource. The merchant answers `402` with a `PAYMENT-REQUIRED` header: network, token (`asset`), `amount` in base units, `payTo`, a timeout, and a one-time nonce.
2. **Prepare.** The client sends its Aztec address (`X-402-PREPARE`). The merchant creates a **commitment** — a partial note on the token contract, via `initialize_transfer_commitment(merchant, client)` — and returns it in a second 402.
3. **Pay and prove.** The client completes the commitment with `transfer_private_to_commitment(client, commitment, amount, 0)`: a private transfer proven locally. It then retries the request with `PAYMENT-SIGNATURE` (client address, tx hash, nonce). The merchant reads the transferred amount from the note-completion log tagged by its commitment, and returns `200` with the content and a `PAYMENT-RESPONSE` header.

## Guarantees

- **Right recipient, by construction.** The merchant created the commitment with itself as recipient. The payment cannot land anywhere else.
- **Only this client can pay this invoice.** The commitment names the client as the only completer.
- **Right amount.** The merchant reads the amount from chain data, not from what the client claims.
- **No replay.** The nonce is single-use and expires; a settled tx hash cannot pay twice.
- **Not guaranteed: delivery.** Payment and delivery are separate steps. A merchant that takes the payment and then fails to respond keeps the money; the client holds the tx hash as proof (`not_delivered`).
- **Spend cap.** The CLI refuses any challenge above the user's `--max-amount`, the per-payment policy, or the 24h limit — before the merchant is asked to prepare, and again right before the transfer is proven.

## What stays private

| Who | Learns |
| --- | --- |
| Public observers of Aztec | That some transactions happened. Not sender, recipient, amount, or token balances. |
| The merchant | That this request was paid, by which Aztec address, and how much. Required to serve it. |
| Observers of Ethereum (L1) | Deposits from L1 into Aztec, when the user funds the agent from Ethereum (see funding.md). |

The content is delivered over HTTP, off-chain, so nothing on-chain links an Aztec transaction to the purchased resource.

## Costs and timing

Each payment is two Aztec transactions: the merchant's prepare and the client's transfer. Fees are paid by a sponsored fee contract on testnet. Expect 1–3 minutes per payment, mostly proof generation and block inclusion.

## Background

- x402 standard: <https://www.x402.org>
- Aztec: <https://aztec.network>
- AIP-20 token standard: <https://github.com/AztecProtocol/aztec-standards>
- Protocol specification and libraries: <https://github.com/Galactica-corp/aztec-x402>
