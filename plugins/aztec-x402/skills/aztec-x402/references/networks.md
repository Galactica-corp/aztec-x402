# Networks, contracts, and endpoints

The CLI carries this registry built in; `aztec-x402 status` prints the live view. Use this page when you need an address the CLI does not print, or when building transactions without the CLI.

## Aztec testnet (default, `--network testnet`)

| Item | Value |
| --- | --- |
| Aztec version | 6.0.0-rc.1 (SDK `@aztec-labs/*@6.0.0-rc.1`) |
| Node RPC | Not published in the packages. Set `AZTEC_X402_NODE_URL` to a node that reports `nodeVersion` `6.0.0-rc.1`. `https://v5.testnet.rpc.aztec-labs.com` is the previous rollup. |
| x402 network id (CAIP-2) | `aztec:testnet` |
| L1 | Sepolia (chain id 11155111), public RPC `https://ethereum-sepolia-rpc.publicnode.com` |
| USDC (AIP-20, 6 decimals) | `0x292f992b7e5db72958bcf1978c54a698fa35967c85e6e5640a40fe5d6fbc39b0` |
| USDC faucet (Dripper, anyone may mint) | `0x215737bae89da9d4703a162c1ccb9c3cae8f1f78b969956795e00d102e7f3e4a` |
| Sponsored FPC (pays fees) | `0x06a9fa0208c78509921b0487a6b5cd5c2e93baf17de1a18d310f65a3cc1d924b` |

USDC and the Dripper are the canonical `aztec-standards` 6.0.0-rc.1 universal deploys (salt 1337): their addresses follow from the artifacts alone. They still have to be deployed on the v6 rollup before they can be used. The v6 testnet node image does not deploy the Sponsored FPC (`SPONSORED_FPC: false`); the local network does.

L1 contracts (Fee Juice portal, fee asset, its faucet) come from the node at run time: `curl -s -X POST <node RPC> -H 'content-type: application/json' -d '{"jsonrpc":"2.0","method":"aztec_getNodeInfo","params":[],"id":1}'` → `result.l1ContractAddresses`.

## Local network (`--network local`)

`aztec start --local-network` (Aztec 6.0.0-rc.1 tooling). Node `http://localhost:8080`, network id `aztec:sandbox`, no real proofs. The local network has no built-in tokens: add one with `config.json` (below).

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
| `http://localhost:4402/api/buy-x402-achievement` | 0.01 USDC | Markdown "achievement" skill |
| `http://localhost:4402/api/weather/<id>` | 0.01 USDC | JSON weather sample |

Both are served by the reference merchant in the aztec-x402 repo: `bun run setup:usdc` once, then `bun run server`. Any x402 endpoint that advertises `scheme: exact` on `aztec:testnet` in a listed token is payable.

## Building transactions without the CLI

- Token artifact: `@aztec-foundation/aztec-standards@6.0.0-rc.1`, `dist/src/artifacts/Token.js` (`TokenContract`). Methods used: `balance_of_private(owner)` (utility), `transfer_private_to_commitment(from, commitment, amount, 0)`, `offchain_receive(messages)` when the 402 carries `extra.offchainMessage`.
- Faucet: `Dripper.js` → `drip_to_private(token, amount)`.
- Accounts: initializerless Schnorr (`createSchnorrInitializerlessAccount`), usable without a deploy transaction.
- Wallet: use the PXE wallet from `@galactica-net/x402-agent/aztec` (`createPXEWallet`). Aztec's stock `EmbeddedWallet` simulates through stub accounts, which breaks the commitment flow on the merchant side.
- Client libraries: `@galactica-net/x402-client` (`wrapFetchWithPayment`) with `ExactAztecClientScheme` from `@galactica-net/x402-mechanism/exact/client`.
