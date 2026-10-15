# Networks, contracts, and endpoints

The CLI carries this registry built in; `aztec-x402 status` prints the live view. Use this page when you need an address the CLI does not print, or when building transactions without the CLI.

## Aztec testnet (default, `--network testnet`)

| Item | Value |
| --- | --- |
| Aztec version | 6.0.0-rc.3 (SDK `@aztec-labs/*@6.0.0-rc.3`; `@aztec-foundation/l1-artifacts@6.0.0-rc.6`) |
| Node RPC | `https://aztec-testnet.drpc.org`. Override with `AZTEC_X402_NODE_URL`. |
| x402 network id (CAIP-2) | `aztec:testnet` |
| L1 | Sepolia (chain id 11155111), public RPC `https://ethereum-sepolia-rpc.publicnode.com` |
| `tUSDC` (test token, AIP-20, 6 decimals) | `0x08b5c7a74699f9336cb31f42872d9f067f52aef34afe2d2eb34dd0c3e3b36358` |
| `tUSDC` faucet (Dripper, anyone may mint) | `0x0fda74986940cb777bfc0c52ed00b590cb05a267364c599d094d164ff1c795d4` |
| `USDC` (inference-money, 6 decimals) | `0x10da653e09b52a37becd30846f5602859b53fdd74f8ee7771e447cd1b9298c22` |
| Sponsored FPC (pays fees) | `0x2adfb70e860909f0db8268b3fec80bce52a94559963444f5c0341816b8412130` |

`USDC` is Sepolia USDC bridged by inference-money. It has no faucet, and a payment in it only goes through to a merchant on the token's list; the CLI refuses any other payee with `merchant_not_listed` before the merchant prepares anything. The CLI tells the two kinds apart by the contract's class on chain.

`tUSDC` and the Dripper are the canonical `aztec-standards` universal deploys (salt 1337) under `DOM_SEP__CONTRACT_ADDRESS_V3`: their addresses follow from the artifacts alone. They still have to be deployed on the rollup before they can be used. The testnet node image does not deploy the Sponsored FPC (`SPONSORED_FPC: false`); the local network does. The Sponsored FPC address is the `SponsoredFPC` artifact at `SPONSORED_FPC_SALT`.

L1 contracts (Fee Juice portal, fee asset, its faucet) come from the node at run time: `curl -s -X POST <node RPC> -H 'content-type: application/json' -d '{"jsonrpc":"2.0","method":"aztec_getNodeInfo","params":[],"id":1}'` → `result.l1ContractAddresses`.

## Local network (`--network local`)

`aztec start --local-network` (Aztec 6.0.0-rc.3 tooling). Node `http://localhost:8080`, network id `aztec:sandbox`, no real proofs. The local network has no built-in tokens: add one with `config.json` (below). The aztec-x402 repo's `bun run setup:sandbox` (AIP-20) and `bun run setup:sandbox:inference` (inference-money USDC) deploy one and print its address in `deploy.json`.

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
