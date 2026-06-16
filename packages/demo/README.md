# @galactica-net/x402-demo

Demo of x402 payment-gated API on Aztec — both mock (no blockchain needed) and real (against Aztec testnet or sandbox).

Part of [aztec-x402](https://github.com/Galactica-corp/aztec-x402).

## Quick start (mock — no blockchain)

```bash
# Terminal 1: start server
bun run ./packages/demo/src/server.ts

# Terminal 2: call paid API
bun run ./packages/demo/src/client.ts
```

This uses mock signers — proves the protocol logic works end-to-end but doesn't touch a real chain.

---

## Real demo (against Aztec sandbox)

This runs actual private token transfers on a local Aztec network.

### Prerequisites

- **Docker** — the Aztec sandbox runs in Docker
- **Node.js v22+** — for the Aztec CLI
- **bun** — for running the demo code

### Step 1: Install the Aztec sandbox

```bash
# Install the Aztec toolchain (version 0.87.9)
VERSION=0.87.9 bash -i <(curl -sL https://install.aztec.network)
```

This installs `aztec`, `aztec-up`, and `aztec-wallet` CLI tools.

### Step 2: Start the sandbox

```bash
aztec start --sandbox
```

Wait until you see:
```
[INFO] Aztec Server listening on port 8080
```

The sandbox provides:
- A local Aztec chain with sequencer
- A PXE (Private eXecution Environment) at `http://localhost:8080`
- 3 pre-funded test accounts

### Step 3: Install dependencies

```bash
cd aztec-x402
bun install
```

### Step 4: Run the setup script

```bash
bun run ./packages/demo/src/aztec/setup.ts
```

This will:
1. Connect to the sandbox PXE at `localhost:8080`
2. Load the pre-deployed test accounts (Alice = payer, Bob = server)
3. Deploy an `Overcast USD` (oUSD) token contract with 6 decimals
4. Mint 1,000,000 units (1.0 oUSD) to Alice's private balance
5. Register cross-party senders for note discovery
6. Write deployment info to `packages/demo/src/aztec/deploy.json`

Expected output:
```
Connecting to Aztec sandbox at http://localhost:8080...
Connected.

Loading test accounts...
  Alice (payer):       0x1234...
  Bob   (server):      0x5678...

Deploying Overcast USD (oUSD)...
  Token deployed at:   0xabcd...

Minting 1000000 to Alice's private balance...
  Alice's balance:     1000000

Setup complete!
```

### Step 5: Start the real server

```bash
bun run ./packages/demo/src/aztec/real-server.ts
```

This starts an HTTP server on port 4402 that:
- Gates `/api/weather` behind a 100,000 unit ($0.10) oUSD payment
- Uses a real `FacilitatorAztecSigner` connected to Bob's wallet
- Verifies payments by checking PXE balance deltas

### Step 6: Run the real client

```bash
bun run ./packages/demo/src/aztec/real-client.ts
```

This will:
1. Connect to the sandbox as Alice
2. Check Alice's private token balance
3. Request `/api/weather` — gets a 402 response
4. Execute a real `transfer_private_to_private` on-chain
5. Retry with the payment proof
6. Get the weather data back
7. Show the balance change

Expected output:
```
Connecting to Aztec sandbox at http://localhost:8080...
Payer address: 0x1234...
Balance before: 1000000

Fetching http://localhost:4402/api/weather (payment-gated)...

Response (200):
{
  "location": "Aztec Network",
  "temperature": 21,
  "conditions": "Clear skies, private transactions flowing smoothly",
  "paid": true,
  "network": "aztec:sandbox"
}

Balance after: 900000
Spent: 100000
```

---

## Environment variables

| Variable     | Default                  | Description                |
|-------------|--------------------------|----------------------------|
| `PXE_URL`   | `http://localhost:8080`  | Aztec PXE endpoint         |
| `SERVER_URL`| `http://localhost:4402`  | x402 demo server endpoint  |

---

## Architecture

```
                     Aztec Sandbox (Docker)
                    ┌──────────────────────┐
                    │  Chain + Sequencer    │
                    │  PXE (port 8080)     │
                    └──────┬───────────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
    ┌─────▼─────┐   ┌─────▼─────┐   ┌──────▼──────┐
    │  Setup     │   │  Server   │   │   Client    │
    │  script    │   │  (Bob)    │   │   (Alice)   │
    │            │   │           │   │             │
    │ Deploy oUSD│   │ Facilitator│   │ Client     │
    │ Mint tokens│   │ Signer    │   │ Signer     │
    │            │   │ Middleware │   │ payFetch() │
    └────────────┘   └─────┬─────┘   └──────┬─────┘
                           │                 │
                           │  HTTP (4402)    │
                           ◄─────────────────┘
                        402 → pay → retry → 200
```

## Troubleshooting

**"deploy.json not found"** — Run the setup script first: `bun run ./packages/demo/src/aztec/setup.ts`

**"Connection refused on port 8080"** — The sandbox isn't running. Start it with `aztec start --sandbox`

**"Need at least 2 test accounts"** — Import test accounts: `aztec-wallet import-test-accounts`

**Version mismatch errors** — Make sure the Aztec CLI version matches the npm packages (both should be 0.87.9). Check with `aztec --version`.
