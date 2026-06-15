# @galactica-net/mechanism

x402 mechanism plugin for Aztec — client, facilitator, and server schemes for private commitment-based payments.

Part of [aztec-x402](https://github.com/Galactica-corp/aztec-x402).

## Install

```bash
npm install @galactica-net/mechanism
```

## Usage

```ts
import { ExactAztecClientScheme } from "@galactica-net/mechanism/exact/client";
import { ExactAztecFacilitatorScheme } from "@galactica-net/mechanism/exact/facilitator";
import { ExactAztecServerScheme } from "@galactica-net/mechanism/exact/server";
import { PaymentRequirementsSchema } from "@galactica-net/mechanism";
```

The **client scheme** signs and finalizes transfers. The **facilitator scheme** verifies on-chain payments and settles. The **server scheme** parses prices and shapes payment requirements.

Depends on [`@galactica-net/core`](https://www.npmjs.com/package/@galactica-net/core).

## License

Apache-2.0 — see [LICENSE](https://github.com/Galactica-corp/aztec-x402/blob/main/LICENSE).
