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

Depends on [`@galactica-net/x402-core`](https://www.npmjs.com/package/@galactica-net/x402-core) and [`@galactica-net/x402-mechanism`](https://www.npmjs.com/package/@galactica-net/x402-mechanism).

## License

Apache-2.0 — see [LICENSE](https://github.com/Galactica-corp/aztec-x402/blob/main/LICENSE).
