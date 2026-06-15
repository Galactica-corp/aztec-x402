# @galactica-net/client

Fetch wrapper that handles x402 payments on Aztec automatically — 402 detection, prepare, payment, and retry.

Part of [aztec-x402](https://github.com/Galactica-corp/aztec-x402).

## Install

```bash
npm install @galactica-net/client
```

## Usage

```ts
import { ExactAztecClientScheme } from "@galactica-net/mechanism/exact/client";
import { wrapFetchWithPayment } from "@galactica-net/client";

const scheme = new ExactAztecClientScheme(signer);
const fetchWithPayment = wrapFetchWithPayment(fetch, scheme);

const response = await fetchWithPayment("https://api.example.com/weather/london");
```

Wraps `fetch` to run the 3-phase x402 flow: initial 402 → prepare (server commitment) → payment (client transfer + retry).

Depends on [`@galactica-net/core`](https://www.npmjs.com/package/@galactica-net/core) and [`@galactica-net/mechanism`](https://www.npmjs.com/package/@galactica-net/mechanism).

## License

Apache-2.0 — see [LICENSE](https://github.com/Galactica-corp/aztec-x402/blob/main/LICENSE).
