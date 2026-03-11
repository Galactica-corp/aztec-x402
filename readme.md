# aztech-x402

x402 HTTP 402 payment protocol for Aztec private stablecoins.

## Overview

This monorepo implements the [x402 protocol](https://www.x402.org) for [Aztec](https://aztec.network) private tokens, enabling HTTP-native micropayments with full transaction privacy.

### How it works

1. Client requests a resource from a server
2. Server responds with **HTTP 402** + payment requirements (Aztec address, amount, token)
3. Client executes `transfer_private_to_private` on the Aztec token contract
4. Client retries the request with sender address + correlation ID
5. Server's PXE discovers the incoming token note and verifies the payment amount
6. Server returns the resource

All payments are fully private — transaction contents are hidden on-chain.

## Packages

| Package | Description |
|---------|-------------|
| `@aztech-x402/core` | Types, constants, signer abstractions |
| `@aztech-x402/mechanism` | x402 mechanism plugin (client/facilitator/server schemes) |
| `@aztech-x402/middleware` | Express middleware for payment-gated routes |
| `@aztech-x402/client` | Fetch wrapper for automatic 402 handling |

## Development

```bash
bun install
bun test
bun run build
```

## Architecture

The plugin implements three x402 interfaces:

- **SchemeNetworkClient** — Signs and submits private transfers
- **SchemeNetworkFacilitator** — Verifies payments via PXE note discovery, acknowledges settlement
- **SchemeNetworkServer** — Parses prices and constructs payment requirements

### Aztec-specific design decisions

- **`transfer_private_to_private` only** — all payments stay fully private
- **Sender address, not tx hash** — private tx contents are hidden, so the server identifies payments by sender address
- **PXE note discovery** — server registers the sender and checks its balance delta to verify payment
- **KYC compliance** — handled by the token contract's built-in hooks (deferred for v1)
