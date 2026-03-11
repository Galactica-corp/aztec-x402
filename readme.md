# aztech-x402

x402 payment protocol for Aztec private tokens — HTTP-native micropayments with full transaction privacy.

This monorepo implements the [x402 protocol](https://www.x402.org) for [Aztec](https://aztec.network), allowing any HTTP API to be payment-gated using private stablecoin transfers. All payments use `transfer_private_to_private` — sender, receiver, and amount are hidden on-chain.

## Protocol Flow

```mermaid
sequenceDiagram
    participant Client as Client (Alice)
    participant Server as Server + Middleware
    participant Node as Aztec Node
    participant Chain as Aztec Chain

    Client->>Server: GET /api/weather
    Server-->>Client: 402 + PAYMENT-REQUIRED<br/>{asset, amount, payTo, nonce}

    Client->>Node: transfer_private_to_private(bob, 10000)
    Node->>Chain: Submit private tx (encrypted notes)
    Chain-->>Node: Tx settled

    Client->>Server: GET /api/weather<br/>PAYMENT-SIGNATURE: {senderAddr, txHash, nonce}

    Note over Server: Validate nonce (anti-replay)
    Server->>Node: getTxReceipt(txHash) → settled?

    Note over Server: Consume nonce + record txHash
    Server-->>Client: 200 OK + weather data<br/>PAYMENT-RESPONSE: {tx, payer}
```

## Anti-Replay Protection

The middleware uses a two-layer defense against payment replay attacks:

```mermaid
flowchart TD
    A[Client sends PAYMENT-SIGNATURE] --> B{Nonce present?}
    B -- No --> R1[402: missing payment nonce]
    B -- Yes --> C{Nonce in pendingNonces?}
    C -- No --> R2[402: invalid or expired payment nonce]
    C -- Yes --> D{Nonce expired?}
    D -- Yes --> R3[402: invalid or expired payment nonce]
    D -- No --> E[Consume nonce — delete from Map]
    E --> F{txHash already used?}
    F -- Yes --> R4[402: payment already used]
    F -- No --> G[getTxReceipt — tx succeeded?]
    G -- No --> R5a[402: tx failed/dropped]
    G -- Yes --> J2[Settle + record txHash]
    J2 --> J[200 OK + PAYMENT-RESPONSE]

    style E fill:#2d6,color:#fff
    style J2 fill:#2d6,color:#fff
    style R1 fill:#d33,color:#fff
    style R2 fill:#d33,color:#fff
    style R3 fill:#d33,color:#fff
    style R4 fill:#d33,color:#fff
    style R5a fill:#d33,color:#fff
```

**Layer 1 — Nonce (middleware):** Each 402 response includes a server-generated UUID v7 nonce in `extra.nonce`. The client echoes it back automatically via `accepted.extra`. The nonce is one-shot (consumed on use) and expires after `maxTimeoutSeconds`. This binds each payment to a specific 402 challenge.

**Layer 2 — txHash Set (facilitator):** The facilitator records every settled txHash. Even if a nonce is somehow bypassed, the same txHash cannot be used twice. Defense-in-depth.

## Package Architecture

```mermaid
graph LR
    subgraph Client Side
        CL["@aztech-x402/client<br/><i>wrapFetchWithPayment()</i>"]
        MC["mechanism/client<br/><i>ExactAztecClientScheme</i>"]
    end

    subgraph Server Side
        MW["@aztech-x402/middleware<br/><i>createPaymentMiddleware()</i><br/>Nonce lifecycle"]
        MF["mechanism/facilitator<br/><i>ExactAztecFacilitatorScheme</i><br/>txHash anti-replay"]
    end

    CO["@aztech-x402/core<br/><i>Types, signer interfaces</i>"]

    CL --> MC
    MW --> MF
    MC --> CO
    MF --> CO
    CL -.->|HTTP 402 / 200| MW

    style CL fill:#46d,color:#fff
    style MC fill:#46d,color:#fff
    style MW fill:#d84,color:#fff
    style MF fill:#d84,color:#fff
    style CO fill:#555,color:#fff
```

| Package | Description |
|---------|-------------|
| `@aztech-x402/core` | Types, constants, signer abstractions (`ClientAztecSigner`, `FacilitatorAztecSigner`) |
| `@aztech-x402/mechanism` | x402 mechanism plugin — client scheme (sign + transfer) and facilitator scheme (verify + settle) |
| `@aztech-x402/middleware` | Express-compatible middleware — 402 responses, nonce lifecycle, payment verification |
| `@aztech-x402/client` | Fetch wrapper — automatic 402 detection, payment, and retry |
| `@aztech-x402/demo` | Mock demo + real Aztec devnet demo + replay attack test |

## Quick Start (Mock — No Blockchain)

```bash
bun install

# Terminal 1: start mock server
bun run ./packages/demo/src/server.ts

# Terminal 2: call paid API
bun run ./packages/demo/src/client.ts
```

Uses mock signers — proves the full protocol flow without touching a real chain.

## Real Demo (Aztec Devnet)

Runs actual private token transfers on the Aztec devnet using `EmbeddedWallet` and Sponsored FPC for gas.

### Prerequisites

- **bun** — for running the demo code

### Step 1: Deploy accounts and token

```bash
bun install

# Point at the Aztec devnet node
NODE_URL=https://v4-devnet-2.aztec-labs.com \
AZTEC_NETWORK=aztec:devnet \
USE_SPONSORED_FPC=true \
bun run ./packages/demo/src/aztec/setup.ts
```

This generates Schnorr key pairs (`keys.json`), deploys Alice and Bob accounts on devnet, deploys an Overcast USD (oUSD) token, mints 1,000,000 units (1.0 oUSD) to Alice, and writes config to `packages/demo/src/aztec/deploy.json`.

### Step 2: Start the server

```bash
bun run ./packages/demo/src/aztec/real-server.ts
```

Gates `GET /api/weather` behind a 10,000 unit ($0.01) oUSD private payment. Runs on port 4402.

### Step 3: Run the client

```bash
bun run ./packages/demo/src/aztec/real-client.ts
```

Expected output:

```
Connecting to Aztec node at https://v4-devnet-2.aztec-labs.com/...
Payer address: 0x1d90...
Balance before: 1000000

Fetching http://localhost:4402/api/weather (payment-gated)...

Response (200):
{
  "location": "Aztec Network",
  "temperature": 21,
  "conditions": "Clear skies, private transactions flowing smoothly",
  "paid": true,
  "network": "aztec:devnet"
}

Balance after: 990000
Spent: 10000
```

### Step 4: Test anti-replay protection

```bash
bun run ./packages/demo/src/aztec/replay-test.ts
```

Sends a payment, then replays the exact same `PAYMENT-SIGNATURE` header. First request gets 200, replay gets 402 "invalid or expired payment nonce".

## Development

```bash
bun install
bun test        # Run all tests (84 across 5 packages)
bun run build   # Build all packages
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_URL` | `http://localhost:8080` | Aztec node endpoint |
| `AZTEC_NETWORK` | `aztec:sandbox` | CAIP-2 network id (`aztec:sandbox` or `aztec:devnet`) |
| `USE_SPONSORED_FPC` | `false` | Use Sponsored FPC for gas fees (required on devnet) |
| `SERVER_URL` | `http://localhost:4402` | x402 demo server endpoint (client only) |

## Design Decisions

- **`transfer_private_to_private` only** — all payments stay fully private on-chain
- **Tx receipt verification** — server verifies the payment transaction settled on-chain via `getTxReceipt`; the ZK proof guarantees correctness of the private transfer
- **Server = facilitator** — no separate facilitator service; the server verifies and settles payments directly
- **Nonce in `extra` field** — flows through the protocol without any client-side code changes
- **UUID v7 nonces** — time-ordered for debuggability, expire after `maxTimeoutSeconds`

## Docs

- [Status Report](docs/status-report.md) — sandbox testing log and known issues
- [Anti-Replay (RU)](docs/anti-replay-ru.md) — txHash-based anti-replay explanation (Russian)
- [Full Report (RU)](docs/report-ru.md) — implementation report (Russian)
