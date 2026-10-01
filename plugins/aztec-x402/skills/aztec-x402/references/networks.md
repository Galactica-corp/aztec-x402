# Networks, contracts, and endpoints

The CLI carries this registry built in; `aztec-x402 status` prints the live view. Use this page when you need an address the CLI does not print, or when building transactions without the CLI.

## Aztec testnet (default, `--network testnet`)

| Item | Value |
| --- | --- |
| Aztec version | 5.0.x (SDK `@aztec/*@5.0.1`) |
| Node RPC | `https://v5.testnet.rpc.aztec-labs.com` |
| x402 network id (CAIP-2) | `aztec:testnet` |
| L1 | Sepolia (chain id 11155111), public RPC `https://ethereum-sepolia-rpc.publicnode.com` |
| USDC (AIP-20, 6 decimals) | `0x2bb09ca02aeabb84fbe69537a0bf4b5ed57112466dc4666f9639157fe8dcfcf7` |
| USDC faucet (Dripper, anyone may mint) | `0x064399d44c7ba2380dc7f8e8a8395189879ab7cc71c1ac5c4ca63a35a25815fd` |
| Sponsored FPC (pays fees) | `0x1441491b59934ec64f8c98f17c91f23c01ca2a45dbb35caf123146ec76f9970c` |

USDC and the Dripper are the canonical `aztec-standards` 5.0.1 universal deploys (salt 1337): their addresses follow from the artifacts alone.

L1 contracts (Fee Juice portal, fee asset, its faucet) come from the node at run time: `curl -s -X POST <node RPC> -H 'content-type: application/json' -d '{"jsonrpc":"2.0","method":"node_getNodeInfo","params":[],"id":1}'` → `result.l1ContractAddresses`.

## Local network (`--network local`)

`aztec start --local-network` (Aztec 5.0.1 tooling). Node `http://localhost:8080`, network id `aztec:sandbox`, no real proofs. The local network has no built-in tokens: add one with `config.json` (below).

## Adding a token or overriding the node

`<agent home>/config.json` (agent home defaults to `~/.aztec-x402`; override with `AZTEC_X402_HOME`):

```json
{
  "network": "testnet",
  "tokens": {
    "testnet": [{ "symbol": "oUSD", "name": "Overcast USD", "address": "0x…", "decimals": 6 }]
  }
}
```

The CLI only pays in tokens listed in the registry or this file. Environment overrides: `AZTEC_X402_NETWORK`, `AZTEC_X402_NODE_URL`, `AZTEC_X402_L1_RPC_URL`.

## Paid endpoints

| Endpoint | Price | Returns |
| --- | --- | --- |
| `http://localhost:4402/api/buy-x402-achievement` | 0.01 USDC | Markdown "achievement" skill |
| `http://localhost:4402/api/weather/<id>` | 0.01 USDC | JSON weather sample |

Both are served by the reference merchant in the aztec-x402 repo: `bun run setup:usdc` once, then `bun run server`. Any x402 endpoint that advertises `scheme: exact` on `aztec:testnet` in a listed token is payable.

## Building transactions without the CLI

- Token artifact: `@aztec-foundation/aztec-standards@5.0.1`, `dist/src/artifacts/Token.js` (`TokenContract`). Methods used: `balance_of_private(owner)` (utility), `transfer_private_to_commitment(from, commitment, amount, 0)`, `offchain_receive(messages)` when the 402 carries `extra.offchainMessage`.
- Faucet: `Dripper.js` → `drip_to_private(token, amount)`.
- Accounts: initializerless Schnorr (`createSchnorrInitializerlessAccount`), usable without a deploy transaction.
- Wallet: use the PXE wallet from `@galactica-net/x402-agent/aztec` (`createPXEWallet`). Aztec's stock `EmbeddedWallet` simulates through stub accounts, which breaks the commitment flow on the merchant side.
- Client libraries: `@galactica-net/x402-client` (`wrapFetchWithPayment`) with `ExactAztecClientScheme` from `@galactica-net/x402-mechanism/exact/client`.
