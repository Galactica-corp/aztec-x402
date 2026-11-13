# @galactica-net/x402-middleware

Express-compatible middleware for x402 payment gating on Aztec — 3-phase 402 flow, nonce lifecycle, and payment verification.

Part of [aztec-x402](https://github.com/Galactica-corp/aztec-x402).

## Install

```bash
npm install @galactica-net/x402-middleware
```

## Usage

```ts
import { ExactAztecFacilitatorScheme } from "@galactica-net/x402-mechanism/exact/facilitator";
import { createPaymentMiddleware } from "@galactica-net/x402-middleware";

const facilitator = new ExactAztecFacilitatorScheme(signer, ["aztec:testnet"]);
await facilitator.initialize();

const middleware = createPaymentMiddleware(
  {
    "/api/weather": {
      network: "aztec:testnet",
      asset: TOKEN_ADDRESS,
      amount: "10000",
      payTo: SERVER_ADDRESS,
      maxTimeoutSeconds: 60,
    },
  },
  { facilitator },
);

app.use(middleware);
```

Handles the server side of the commitment-based flow: returns 402 with a nonce, creates transfer commitments on prepare, and verifies settlement before serving protected routes.

### Private amounts and payment from Ethereum (`ref`, `split`)

For the inference-money USDC, a route can offer more payments in the same 402 (`modes`, most private first). They need a durable store and a secret:

```ts
import { createPaymentMiddleware, sqliteStateStore } from "@galactica-net/x402-middleware";

const middleware = createPaymentMiddleware(
  { "/api/weather": { network: "aztec:testnet", asset: USDC, amount: "10000", payTo: MERCHANT, maxTimeoutSeconds: 600, modes: ["ref", "split", "commitment"] } },
  { facilitator, store: sqliteStateStore("./x402-state.sqlite"), secret /* ≥ 32 random bytes, kept and shared by every instance */ },
);
```

- A payment reference is an HMAC of the nonce and the quoted terms under `secret`: a 402 writes nothing, and a proof is accepted only for the nonce, route and price it was quoted for.
- A presented proof is stored before it is verified; the reference is marked served (one atomic insert) before the resource is. A proof of an expired quote is still taken within `retentionMs` (default 26 h, the offchain-message lifetime).
- A mode left out of `modes` is never offered or accepted, `commitment` included. When none of the listed modes is available, the 402 has no `accepts` entries.
- A payment that may verify later (not mined, deposit not deep enough) is answered with a 402 carrying `retryable: true`; clients resend the same payload.
- `sqliteStateStore` uses `node:sqlite` (Node 22.13+, Bun). Several processes on one host may share its file; servers on several hosts need a `PaymentStateStore` on a shared database.

The merchant side (taking proofs in, consolidating, claiming split deposits) is in `@galactica-net/x402-agent/aztec`: `createMerchant()` sets it up together with this middleware and a SQLite store, so a server needs only `merchant.middleware(routes)`. See the [merchant guide](../../docs/inference-money-merchant-guide.md).

Depends on [`@galactica-net/x402-core`](https://www.npmjs.com/package/@galactica-net/x402-core) and [`@galactica-net/x402-mechanism`](https://www.npmjs.com/package/@galactica-net/x402-mechanism).

## License

Apache-2.0 — see [LICENSE](https://github.com/Galactica-corp/aztec-x402/blob/main/LICENSE).
