# aztec-x402

x402 payment protocol for Aztec private tokens — HTTP-native micropayments with full transaction privacy.

This monorepo implements the [x402 protocol](https://www.x402.org) for [Aztec](https://aztec.network), allowing any HTTP API to be payment-gated using private stablecoin transfers. All payments use private transfers — sender, receiver, and amount are hidden on-chain.

## Protocol Flow

The x402 protocol uses a 3-phase commitment-based payment flow:

```mermaid
sequenceDiagram
    participant Client as Client (Alice)
    participant Server as Server + Middleware
    participant Node as Aztec Node
    participant Chain as Aztec Chain

    Client->>Server: GET /api/weather/london
    Server-->>Client: 402 + PAYMENT-REQUIRED<br/>{asset, amount, payTo, nonce}

    Client->>Server: GET /api/weather/london<br/>X-402-PREPARE: {nonce, senderAddress}

    Note over Server: initialize_transfer_commitment(bob, alice)
    Server->>Node: Create commitment (partial note)
    Node->>Chain: Submit prepare tx
    Chain-->>Node: Tx settled
    Server-->>Client: 402 + {nonce, commitment}

    Note over Client: transfer_private_to_commitment<br/>(alice, commitment, amount, 0)
    Client->>Node: Complete transfer using commitment
    Node->>Chain: Submit finalize tx
    Chain-->>Node: Tx settled

    Client->>Server: GET /api/weather/london<br/>PAYMENT-SIGNATURE: {senderAddr, txHash, nonce}

    Note over Server: Validate nonce (anti-replay)
    Server->>Node: getTxReceipt(txHash) + getTxEffect(txHash)

    Note over Server: Consume nonce + record txHash
    Server-->>Client: 200 OK + weather data<br/>PAYMENT-RESPONSE: {tx, payer}
```

### Commitment Pattern — Structural Recipient Verification

The server creates the commitment via `initialize_transfer_commitment(serverAddr, clientAddr)` on the [AIP-20 standard token contract](https://github.com/defi-wonderland/aztec-standards). This provides two guarantees:

1. **Recipient is bound**: the partial note's `to` = server's address — the client can only complete the transfer TO the server
2. **Completer is bound**: only the specified client address can call `transfer_private_to_commitment` for this commitment

This closes the "who did the payment go to?" verification gap that exists with direct `transfer_in_private`.

## Token Contract

This project uses the **AIP-20 standard token** from [`@defi-wonderland/aztec-standards`](https://github.com/defi-wonderland/aztec-standards). AIP-20 natively supports the `completer` parameter in `initialize_transfer_commitment(to, completer)`, enabling cross-party commitment flows where the server prepares and the client finalizes.

The AIP-20 source is compiled locally against `v4.1.0-nightly.20260314` for sandbox compatibility. Once AIP-20 publishes a v4.1.0 npm package, we'll switch to a direct dependency.

### Compilation

The contract is compiled using `nargo` + `bb aztec_process` from the Aztec Docker image. The two-step process: (1) nargo compiles Noir to ACIR bytecode, (2) bb transpiles public functions to AVM bytecode and generates verification keys.

```bash
docker run --rm \
  -v ./packages/contracts/token:/contract \
  --entrypoint sh \
  aztecprotocol/aztec:4.1.0-nightly.20260314 \
  -c "
    cd /contract
    /usr/src/noir/noir-repo/target/release/nargo compile --silence-warnings
    /usr/src/barretenberg/ts/build/arm64-linux/bb aztec_process \
      -i target/token_contract-Token.json
  "
```

After `bb aztec_process`, strip the internal function name prefixes:

```bash
node -e "
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('packages/contracts/token/target/token_contract-Token.json', 'utf8'));
for (const fn of d.functions) fn.name = fn.name.replace(/^__aztec_nr_internals__/, '');
fs.writeFileSync('packages/contracts/token/target/token_contract-Token.json', JSON.stringify(d));
"
```

The compiled artifact is checked in at `packages/contracts/token/target/token_contract-Token.json`.

## Aztec Version Compatibility

| Component | Version | Notes |
|-----------|---------|-------|
| SDK (`@aztec/aztec.js` etc.) | `4.1.0-nightly.20260314` | Offchain delivery support, new send/simulate shapes |
| Contract compilation | `aztecprotocol/aztec:4.1.0-nightly.20260314` | nargo 1.0.0-beta.18 + bb |
| Local sandbox | `aztecprotocol/aztec:4.1.0-nightly.20260314` | Full commitment flow works |
| Devnet | `4.0.0-devnet.2-patch.1` | Commitment flow blocked (see below) |

### v4.1.0 API Changes

The v4.1.0 SDK has significant API shape changes from v4.0.x:

- **`send()`** returns `{ receipt, offchainEffects, offchainMessages }` — txHash is on `receipt.txHash`, not top-level
- **`simulate()`** returns `{ result: Field, offchainEffects, offchainMessages }` — the AIP-20 `initialize_transfer_commitment` returns a raw `Field` (commitment)
- **`offchainMessages`** is present but currently empty (`[]`) for `initialize_transfer_commitment` — the infrastructure for offchain partial note delivery exists (PR [#20893](https://github.com/AztecProtocol/aztec-packages/pull/20893)) but isn't wired up for partial notes yet
- **Contract artifacts** require transpilation via `bb aztec_process` (v4.0.x artifacts fail with "Contract's public bytecode has not been transpiled")

### Devnet Status

The commitment pattern **does not work on devnet** (`4.0.0-devnet.2-patch.1`) due to a known PXE/simulator bug: `transfer_private_to_commitment` fails with "Nullifier witness not found". This bug was fixed in v4.0.4 (PRs [#14379](https://github.com/AztecProtocol/aztec-packages/pull/14379), [#14432](https://github.com/AztecProtocol/aztec-packages/pull/14432), [#14533](https://github.com/AztecProtocol/aztec-packages/pull/14533)), but the devnet hasn't upgraded yet.

### Running the v4.1.0 Sandbox

The v4.1.0 sandbox requires an external L1 (Anvil):

```bash
# Terminal 1: start Anvil (auto-mine mode, no --block-time)
anvil --port 8545

# Terminal 2: start the sandbox
docker run -d --name aztec-sandbox \
  -p 8080:8080 \
  -e LOG_LEVEL=info \
  aztecprotocol/aztec:4.1.0-nightly.20260314 \
  start --local-network --l1-rpc-urls http://host.docker.internal:8545
```

Note: v4.1.0 removed the `--sandbox` flag. Use `start --local-network` instead.

## Anti-Replay Protection

The middleware uses a two-layer defense against payment replay attacks:

**Layer 1 — Nonce (middleware):** Each 402 response includes a server-generated UUID v7 nonce in `extra.nonce`. The client echoes it back automatically via `accepted.extra`. The nonce is one-shot (consumed on use) and expires after `maxTimeoutSeconds`. This binds each payment to a specific 402 challenge.

**Layer 2 — txHash Set (facilitator):** The facilitator records every settled txHash. Even if a nonce is somehow bypassed, the same txHash cannot be used twice. Defense-in-depth.

## Package Architecture

```mermaid
graph LR
    subgraph Client Side
        CL["@aztec-x402/client<br/><i>wrapFetchWithPayment()</i>"]
        MC["mechanism/client<br/><i>ExactAztecClientScheme</i>"]
    end

    subgraph Server Side
        MW["@aztec-x402/middleware<br/><i>createPaymentMiddleware()</i><br/>3-phase flow + nonce lifecycle"]
        MF["mechanism/facilitator<br/><i>ExactAztecFacilitatorScheme</i><br/>Commitment + txHash anti-replay"]
    end

    CT["@aztec-x402/contracts<br/><i>AIP-20 TokenContract</i>"]
    CO["@aztec-x402/core<br/><i>Types, signer interfaces</i>"]

    CL --> MC
    MW --> MF
    MC --> CO
    MF --> CO
    CL -.->|HTTP 402 / 200| MW
    MF --> CT
    MC --> CT

    style CL fill:#46d,color:#fff
    style MC fill:#46d,color:#fff
    style MW fill:#d84,color:#fff
    style MF fill:#d84,color:#fff
    style CT fill:#2a7,color:#fff
    style CO fill:#555,color:#fff
```

| Package | Description |
|---------|-------------|
| `@aztec-x402/core` | Types, constants, signer abstractions (`ClientAztecSigner`, `FacilitatorAztecSigner`) |
| `@aztec-x402/contracts` | AIP-20 standard token contract compiled for Aztec v4.1.0 |
| `@aztec-x402/mechanism` | x402 mechanism plugin — client scheme (sign + transfer) and facilitator scheme (verify + settle) |
| `@aztec-x402/middleware` | Express-compatible middleware — 3-phase 402 flow, nonce lifecycle, payment verification |
| `@aztec-x402/client` | Fetch wrapper — automatic 402 detection, prepare, payment, and retry |
| `@aztec-x402/demo` | Real Aztec demo + mock demo + replay attack test |

## Quick Start

```bash
bun install

# Run tests
bun test

# One-time: deploy accounts + AIP-20 token on local sandbox
# Requires: Aztec sandbox running (see "Running the v4.1.0 Sandbox" above)
USE_SPONSORED_FPC=true bun run setup

# Run the payment-gated client demo
bun run demo
```

### What happens

1. **`bun run setup`** — generates Schnorr key pairs (`keys.json`), deploys Alice and Bob accounts, deploys the AIP-20 token contract (oUSD), mints 1.0 oUSD to Alice, and writes config to `deploy.json`.

2. **`bun run demo`** — Alice pays $0.01 oUSD for a weather resource. The 3-phase flow: (1) client gets 402 with nonce, (2) client sends prepare request with sender address, server creates commitment, (3) client finalizes transfer using commitment, sends txHash to server. Server verifies and returns weather data.

## Known Issues and TODOs

### Simulate/Send Commitment Mismatch

**Status: Known limitation — waiting on Aztec offchain delivery for partial notes.**

`simulate()` and `send()` are independent executions with potentially different randomness. The commitment extracted from `simulate()` may not match the one that goes on-chain via `send()`. The `send()` result (`{ receipt, offchainEffects, offchainMessages }`) does not expose the commitment — `offchainMessages` is empty (`[]`) for `initialize_transfer_commitment` on v4.1.0.

**Mitigations in place:**
- `PXEWallet` uses real account entrypoints for simulation, which aligns randomness with what `send()` does internally — this works in practice on the sandbox but is not a guaranteed fix
- Code is ready to prefer `offchainMessages` when Aztec wires up offchain delivery for partial notes (PR [#20893](https://github.com/AztecProtocol/aztec-packages/pull/20893) added the infrastructure)

**Question for Aztec:** What's the intended pattern for extracting the commitment from an `initialize_transfer_commitment` call? When will `offchainMessages` be populated for partial notes?

### Amount Verification via balance_of_private

The facilitator snapshots its private balance before `prepareCommitment()` and checks again after finalization. The difference is the actual amount transferred. This works but has limitations:
- Depends on `balance_of_private` being available (falls back to trusting tx effects if not)
- Concurrent payments could produce incorrect diffs (demo-only concern — production would need per-commitment accounting)

**Question for Aztec:** Is there a way to verify the transfer amount from tx effects in private transfers?

### Payment Attribution

Each 402 challenge includes a server-generated UUID v7 nonce that acts as the invoice/correlation ID. The nonce binds each payment to a specific request and is tracked by the middleware throughout the 3-phase flow. For external invoice correlation, the server can map nonces to its own invoice system via the `extra` field.

### Devnet Compatibility

The commitment pattern does not work on devnet (`4.0.0-devnet.2-patch.1`) — see [Devnet Status](#devnet-status). Blocked until devnet upgrades to v4.0.4+.

### Other TODOs

- [ ] Switch to stable v4.1.0 release when available (currently on nightly)
- [ ] Consume offchain messages when Aztec wires up partial note delivery
- [ ] Add `offchain_receive()` client-side call when offchain messages are populated
- [ ] Switch to AIP-20 npm package when v4.1.0 is published
- [ ] E2e integration test (setup + full payment flow in CI)

## Development

```bash
bun install
bun test        # Run all tests
bun run build   # Build all packages
```

### Recompiling the Token Contract

If you need to recompile the AIP-20 token contract (e.g. for a different Aztec version), use the Docker image:

```bash
# Compile + transpile
docker run --rm \
  -v ./packages/contracts/token:/contract \
  --entrypoint sh \
  aztecprotocol/aztec:4.1.0-nightly.20260314 \
  -c "
    cd /contract
    /usr/src/noir/noir-repo/target/release/nargo compile --silence-warnings
    /usr/src/barretenberg/ts/build/arm64-linux/bb aztec_process \
      -i target/token_contract-Token.json
  "

# Strip internal prefixes
node -e "
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('packages/contracts/token/target/token_contract-Token.json', 'utf8'));
for (const fn of d.functions) fn.name = fn.name.replace(/^__aztec_nr_internals__/, '');
fs.writeFileSync('packages/contracts/token/target/token_contract-Token.json', JSON.stringify(d));
"
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_URL` | `http://localhost:8080` | Aztec node endpoint |
| `AZTEC_NETWORK` | `aztec:sandbox` | CAIP-2 network id |
| `USE_SPONSORED_FPC` | — | Set to `true` to use Sponsored FPC for gas fees (required for v4.1.0 sandbox) |
| `SERVER_URL` | `https://aztec-x402.unfazed.engineering` | x402 demo server endpoint (client only) |

## Design Decisions

- **Commitment-based transfers** — server creates commitment (partial note) binding the recipient, client completes the transfer. Provides structural recipient verification.
- **AIP-20 standard token** — uses the [`@defi-wonderland/aztec-standards`](https://github.com/defi-wonderland/aztec-standards) token which natively supports the `completer` parameter for cross-party commitment flows.
- **3-phase HTTP flow** — initial 402 → prepare (server creates commitment) → payment (client finalizes + proves)
- **Tx receipt + tx effect verification** — server verifies the payment transaction settled and produced private notes
- **Server = facilitator** — no separate facilitator service; the server verifies and settles payments directly
- **Nonce in `extra` field** — flows through the protocol without any client-side code changes
- **UUID v7 nonces** — time-ordered for debuggability, expire after `maxTimeoutSeconds`
- **PXEWallet over EmbeddedWallet** — uses real account entrypoints for simulation, avoiding the stub-account mismatch that causes different commitments between simulate and send
