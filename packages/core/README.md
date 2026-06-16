# @galactica-net/x402-core

Core types, constants, and signer abstractions for the [x402](https://www.x402.org) payment protocol on [Aztec](https://aztec.network).

Part of [aztec-x402](https://github.com/Galactica-corp/aztec-x402) — HTTP-native micropayments with private stablecoin transfers.

## Install

```bash
npm install @galactica-net/x402-core
```

## Usage

```ts
import {
  type ClientAztecSigner,
  type FacilitatorAztecSigner,
  SCHEME,
  parsePrice,
  parseAztecPaymentExtra,
} from "@galactica-net/x402-core";
```

Provides shared types (`ClientAztecSigner`, `FacilitatorAztecSigner`), network constants, Zod schemas, and helpers used by the other `@galactica-net/x402-*` packages.

## License

Apache-2.0 — see [LICENSE](https://github.com/Galactica-corp/aztec-x402/blob/main/LICENSE).
