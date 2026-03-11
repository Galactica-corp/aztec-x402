## Status Report — Sandbox Testing (2026-03-11)

Ran the full demo end-to-end on Aztec sandbox v0.87.9. Two API bugs were fixed and pushed.

### What's Done
- **Repo scaffold + sandbox** — monorepo with 5 packages, sandbox works on Docker
- **@aztech-x402/mechanism plugin** — client, facilitator, server schemes all implemented
- **Server middleware** — Express-compatible, returns 402 + PaymentRequirements
- **Client SDK** — fetch wrapper, handles 402 auto-retry with payment
- **Demo endpoint** — mock demo works fully; real Aztec demo partially works
- **Private transfer** — uses `token.methods.transfer(to, amount)` (renamed from `transfer_private_to_private` in v0.87.9). Balance correctly deducted on sender side.
- **HTTP 402 flow** — headers (PAYMENT-REQUIRED, PAYMENT-SIGNATURE, PAYMENT-RESPONSE) all working
- **CAIP-2 network IDs** — `aztec:sandbox`, `aztec:devnet`

### Bugs Fixed Today
- `mint_to_private` signature changed to `(from, to, amount)` in v0.87.9 — was missing `from` param
- `.simulate()` returns value directly in v0.87.9, not `{ result }` — all balance reads were showing `undefined`

### What's Broken — PXE Note Discovery (Core Blocker)
The plan flagged this as the **#1 riskiest unknown** and it is indeed broken. Alice's transfer succeeds (balance goes from 1,000,000 to 900,000), but Bob's PXE does not discover the incoming payment note. The facilitator's `balance_of_private` returns 0, so the server responds with 402 "Payment amount insufficient. Received 0 but expected at least 100000."

Possible causes:
- `registerSender()` may need an AztecAddress object, not a raw string
- Note discovery may be async — balance check happens too fast after transfer
- Shared PXE in sandbox may complicate note tagging
- May need a polling loop or waitForNote-style approach

### What's Not Done
- **PXE note discovery spike** — needs investigation, this is the blocker
- **KYC/compliance hooks** — deferred per plan (waiting for Fred's contract)
- **AuthWit nonce** — deferred
- **Embedded JS wallet** — using pre-deployed sandbox test accounts, not deploying on-network
- **Devnet deployment** — sandbox only
- **Gas abstraction** — client pays (simplest path per plan)

### Wallet
Using pre-funded sandbox test accounts via `getDeployedTestAccountsWallets(pxe)`. The plan calls for an embedded JS wallet with on-network account contract deployment — not implemented yet. The signer interfaces (ClientAztecSigner, FacilitatorAztecSigner) are abstracted, so swapping in a real wallet should be straightforward.

### Token
Using `@aztec/noir-contracts.js/Token` (standard Aztec token), not AIP-20 from defi-wonderland/aztec-standards. Same API shape — plan says "swap in actual stablecoin when ready."

### Trade-offs
| Decision | Plan | Current |
|---|---|---|
| Token contract | AIP-20 standard | @aztec/noir-contracts.js/Token (same API) |
| Wallet | Embedded JS wallet | Sandbox test accounts |
| Verification | PXE note discovery + balance delta | Same approach, but not working yet |
| Transfer function | transfer_private_to_private | transfer (renamed in v0.87.9, same semantics) |
| Facilitator | Server IS facilitator | Same — no separate service |

**Next step:** Spike the PXE note discovery issue — this blocks the entire verification flow.
