# Networks, contracts, and endpoints

The CLI carries this registry built in; `aztec-x402 status` prints the live view. Use this page when you need an address the CLI does not print, or when building transactions without the CLI.

## Aztec testnet (default, `--network testnet`)

| Item | Value |
| --- | --- |
| Aztec version | 6.0.0-rc.3 (SDK `@aztec-labs/*@6.0.0-rc.3`; `@aztec-foundation/l1-artifacts@6.0.0-rc.6`) |
| Node RPC | `https://aztec-testnet.drpc.org`. Override with `AZTEC_X402_NODE_URL`. |
| x402 network id (CAIP-2) | `aztec:testnet` |
| L1 | Sepolia (chain id 11155111), public RPC `https://ethereum-sepolia-rpc.publicnode.com` |
| USDC (AIP-20, 6 decimals) | `0x105e7bafa36de6e4946349c0aa2b3a724761168392d1fe2632ed5649ef1a5c22` |
| USDC faucet (Dripper, anyone may mint) | `0x1f230236880bf1a0604ae52f7ee111a94c4fa48cb271d2c3973ee1ac8911c49c` |
| Sponsored FPC (pays fees) | `0x2adfb70e860909f0db8268b3fec80bce52a94559963444f5c0341816b8412130` |

USDC and the Dripper are the canonical `aztec-standards` universal deploys (salt 1337). Their addresses are what `@aztec-labs/aztec.js@6.0.0-rc.3` derives from the `@aztec-foundation/aztec-standards@6.0.0-rc.1` artifacts under `DOM_SEP__CONTRACT_ADDRESS_V3` (that package has no rc.3 publish). They still have to be deployed on the rollup before they can be used. The testnet node image does not deploy the Sponsored FPC (`SPONSORED_FPC: false`); the local network does. The Sponsored FPC address is the rc.3 `SponsoredFPC` artifact at `SPONSORED_FPC_SALT`.

L1 contracts (Fee Juice portal, fee asset, its faucet) come from the node at run time: `curl -s -X POST <node RPC> -H 'content-type: application/json' -d '{"jsonrpc":"2.0","method":"aztec_getNodeInfo","params":[],"id":1}'` → `result.l1ContractAddresses`.

## Local network (`--network local`)

`aztec start --local-network` (Aztec 6.0.0-rc.3 tooling). Node `http://localhost:8080`, network id `aztec:sandbox`, no real proofs. The local network has no built-in tokens: add one with `config.json` (below).

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

- Token artifact: `@aztec-foundation/aztec-standards@6.0.0-rc.1`, `dist/src/artifacts/Token.js` (`TokenContract`), used with `@aztec-labs/*@6.0.0-rc.3`. Methods used: `balance_of_private(owner)` (utility), `transfer_private_to_commitment(from, commitment, amount, 0)`, `offchain_receive(messages)` when the 402 carries `extra.offchainMessage`.
- Faucet: `Dripper.js` → `drip_to_private(token, amount)`.
- Accounts: initializerless Schnorr (`createSchnorrInitializerlessAccount`), usable without a deploy transaction.
- Wallet: use the PXE wallet from `@galactica-net/x402-agent/aztec` (`createPXEWallet`). Aztec's stock `EmbeddedWallet` simulates through stub accounts, which breaks the commitment flow on the merchant side.
- Client libraries: `@galactica-net/x402-client` (`wrapFetchWithPayment`) with `ExactAztecClientScheme` from `@galactica-net/x402-mechanism/exact/client`.
