# Networks, contracts, and endpoints

The CLI carries this registry built in; `aztec-x402 status` prints the live view. Use this page when you need an address the CLI does not print, or when building transactions without the CLI.

## Aztec testnet (default, `--network testnet`)

| Item | Value |
| --- | --- |
| Aztec version | 6.0.0 (SDK `@aztec-labs/*@6.0.0`; `@aztec-foundation/l1-artifacts@6.0.0`) |
| Node RPC | `https://aztec-testnet.drpc.org`. Override with `AZTEC_X402_NODE_URL`. |
| x402 network id (CAIP-2) | `aztec:testnet` |
| L1 | Sepolia (chain id 11155111), public RPC `https://ethereum-sepolia-rpc.publicnode.com` |
| `tUSDC` (test token, AIP-20, 6 decimals) | `0x27d92f6c4b7890ca4fca1487f2e042984c7427bd210bbc65a544237c11d61fff` |
| `tUSDC` faucet (Dripper, anyone may mint) | `0x057ca5968e5bf2b0aca38f815eb989e44e239059acf6ed8784498ee6d4d8634b` |
| `USDC` (inference-money, 6 decimals) | `0x2609810ea3dbc6b7da45970fcda8c60b2f33cf5d030cf7758075e1e14eb3ef44` (from the `@galactica-net/inference-money-core` manifest) |
| Sponsored FPC (pays fees) | `0x2d8fff82a3b0c15d0a89169e7d8d043e079ab94d52031f1de1e4972ebad169d3` |

`USDC` is Sepolia USDC bridged by inference-money. It has no faucet, and a payment in it only goes through to a merchant on the token's list; the CLI refuses any other payee with `merchant_not_listed` before the merchant prepares anything. The CLI tells the two kinds apart by the contract's class on chain.

`tUSDC` and the Dripper are the canonical `aztec-standards` universal deploys (salt 1337) under `DOM_SEP__CONTRACT_ADDRESS_V3`: their addresses follow from the artifacts alone. They still have to be deployed on the rollup before they can be used. The Sponsored FPC is deployed on testnet. Its address is the `SponsoredFPC` artifact at `SPONSORED_FPC_SALT`.

L1 contracts (Fee Juice portal, fee asset, its faucet) come from the node at run time: `curl -s -X POST <node RPC> -H 'content-type: application/json' -d '{"jsonrpc":"2.0","method":"aztec_getNodeInfo","params":[],"id":1}'` → `result.l1ContractAddresses`.

## Local network (`--network local`)

`aztec start --local-network` (Aztec 6.0.0 tooling). Node `http://localhost:8080`, network id `aztec:sandbox`, no real proofs. The local network has no built-in tokens: add one with `config.json` (below). The aztec-x402 repo's `bun run setup:sandbox` (AIP-20) and `bun run setup:sandbox:inference` (inference-money USDC) deploy one and print its address in `deploy.json`.

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

The CLI only pays in tokens listed in the registry or this file. Environment overrides: `AZTEC_X402_NETWORK`, `AZTEC_X402_NODE_URL`, `AZTEC_X402_L1_RPC_URL`, and `AZTEC_X402_FUND_PAGE_URL` (or `fundPageUrl` in `config.json`) for another hosted copy of `assets/fund.html` — the default is `https://aztec-x402.unfz.to/fund.html`.

## Paid endpoints

| Endpoint | Price | Returns |
| --- | --- | --- |
| `http://localhost:4402/api/buy-x402-achievement` | 0.01 tUSDC | Markdown "achievement" skill |
| `http://localhost:4402/api/weather/<id>` | 0.01 tUSDC | JSON weather sample |

Both are served by the reference merchant in the aztec-x402 repo: `bun run setup:tusdc` once, then `bun run server`. Any x402 endpoint that advertises `scheme: exact` on `aztec:testnet` in a listed token is payable.

## Building transactions without the CLI

- Token artifact (AIP-20; for the inference-money token use `@galactica-net/inference-money-core`'s `payRequest`): `@aztec-foundation/aztec-standards`, `dist/src/artifacts/Token.js` (`TokenContract`). Methods used: `balance_of_private(owner)` (utility), `transfer_private_to_commitment(from, commitment, amount, 0)`, `offchain_receive(messages)` when the 402 carries `extra.offchainMessage`.
- Faucet: `Dripper.js` → `drip_to_private(token, amount)`.
- Accounts: initializerless Schnorr (`createSchnorrInitializerlessAccount`), usable without a deploy transaction.
- Wallet: use the PXE wallet from `@galactica-net/x402-agent/aztec` (`createPXEWallet`). Aztec's stock `EmbeddedWallet` simulates through stub accounts, which breaks the commitment flow on the merchant side.
- Client libraries: `@galactica-net/x402-client` (`wrapFetchWithPayment`) with `ExactAztecClientScheme` from `@galactica-net/x402-mechanism/exact/client`.
