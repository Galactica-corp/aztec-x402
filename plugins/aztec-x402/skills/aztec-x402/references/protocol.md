# How a private x402 payment works

x402 turns HTTP 402 Payment Required into a machine-payable invoice. This flavour settles on **Aztec**, a privacy-first Ethereum L2, with **AIP-20** private stablecoin balances. The CLI runs all of it; this page is for explaining it to the user.

## The three HTTP round trips

1. **Challenge.** The client requests the resource. The merchant answers `402` with a `PAYMENT-REQUIRED` header: network, token (`asset`), `amount` in base units, `payTo`, a timeout, and a one-time nonce.
2. **Prepare.** The client sends its Aztec address (`X-402-PREPARE`). The merchant creates a **commitment** — a partial note on the token contract, via `initialize_transfer_commitment(merchant, client)` — and returns it in a second 402.
3. **Pay and prove.** The client completes the commitment with `transfer_private_to_commitment(client, commitment, amount, 0)`: a private transfer proven locally. It then retries the request with `PAYMENT-SIGNATURE` (client address, tx hash, nonce). The merchant reads the transferred amount from the note-completion log tagged by its commitment, and returns `200` with the content and a `PAYMENT-RESPONSE` header.

## Paying without showing the amount (`ref`)

With the inference-money `USDC`, the merchant's 402 also offers a **payment under a reference**: a random reference instead of a commitment, no prepare step. The client makes a private transfer to the merchant with `pay_private`, which records the reference, and retries the request with the transaction's encrypted messages (the proof) instead of publishing them. The merchant decrypts them, checks the reference and the amount, and serves. Nothing on chain shows the amount or names the merchant, and the merchant sends no transaction. The client keeps the proof until the merchant answers, so a payment that did not reach the merchant is sent again (`pay --resume`). Once the merchant has served a reference it never serves it again, not even to the buyer: if its response is lost after that, the content is gone (`response_lost`). The 402 is the buyer's to pay: if someone else who saw it pays under its reference first, the merchant serves that payment and refuses the buyer's (`payment_superseded`).

## Paying from Ethereum in one step (`split`)

A merchant with an Ethereum connection also offers a **split deposit**: the user deposits a round amount of USDC on Ethereum (say 1 USDC for a 0.01 price) whose secret commits to the merchant, the price and the reference. The merchant serves once the deposit is two blocks deep and claims the price on Aztec in the background. The rest waits as change that the agent collects into its own Aztec wallet (`fund change`; if the merchant served another payment under the reference instead, the agent claims the deposit itself to release the change). Ethereum shows the user's address and a round deposit, never the merchant or the price.

## Guarantees

- **Right recipient, by construction.** The merchant created the commitment with itself as recipient. The payment cannot land anywhere else.
- **Only this client can pay this invoice.** The commitment names the client as the only completer.
- **Right amount.** The merchant reads the amount from chain data, not from what the client claims.
- **No replay.** The nonce is single-use and expires; a settled tx hash cannot pay twice. A reference is bound to its nonce and price, and is served once.
- **Not guaranteed: delivery.** Payment and delivery are separate steps. A merchant that takes the payment and then fails to respond keeps the money; the client holds the tx hash as proof (`not_delivered`). The client has to stay connected until the content arrives: a response lost after the merchant served is not sent again, because serving each payment once is what stops replays (`response_lost`).
- **Spend cap.** The CLI refuses any challenge above the user's `--max-amount`, the per-payment policy, or the 24h limit — before the merchant is asked to prepare, and again right before the transfer is proven.

## What stays private

| Who | Learns |
| --- | --- |
| Public observers of Aztec | That some transactions happened and which token contract they touched. Buyer and merchant addresses stay hidden, and so do private balances. With the commitment flow they also see the amount: it is plaintext in the note-completion log, next to the token's `private_balances` slot. With `ref` the amount travels offchain to the merchant and is not on chain. |
| The merchant | That this request was paid and how much. With the commitment flow also by which Aztec address; with `ref` not even that. With `split`, the user's Ethereum address. |
| Observers of Ethereum (L1) | Deposits from L1 into Aztec, when the user funds the agent from Ethereum (see funding.md). |

The content is delivered over HTTP, off-chain, so nothing on-chain links an Aztec transaction to the purchased resource.

## Costs and timing

A commitment payment is two Aztec transactions: the merchant's prepare and the client's transfer. A `ref` payment is one (the client's). A `split` payment is one Ethereum transaction for the user, then one Aztec claim by the merchant and one by the agent to collect the change. Fees are paid by a sponsored fee contract on testnet. Expect 1–3 minutes per payment, mostly proof generation and block inclusion.

## Background

- x402 standard: <https://www.x402.org>
- Aztec: <https://aztec.network>
- AIP-20 token standard: <https://github.com/AztecProtocol/aztec-standards>
- Protocol specification and libraries: <https://github.com/Galactica-corp/aztec-x402>
