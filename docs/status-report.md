## Status Report — Sandbox Testing (2026-03-11)

Ran the full demo end-to-end on Aztec sandbox v0.87.9. Multiple iterations of bug fixes and verification improvements have been pushed.

### What's Done
- **Repo scaffold + sandbox** — monorepo with 5 packages, sandbox works on Docker
- **@aztech-x402/mechanism plugin** — client, facilitator, server schemes all implemented
- **Server middleware** — Express-compatible, returns 402 + PaymentRequirements
- **Client SDK** — fetch wrapper, handles 402 auto-retry with payment
- **Demo endpoint** — mock demo works fully; real Aztec demo works on sandbox
- **Private transfer** — uses `token.methods.transfer(to, amount)` (renamed from `transfer_private_to_private` in v0.87.9). Balance correctly deducted on sender side.
- **HTTP 402 flow** — headers (PAYMENT-REQUIRED, PAYMENT-SIGNATURE, PAYMENT-RESPONSE) all working
- **CAIP-2 network IDs** — `aztec:sandbox`, `aztec:devnet`
- **Per-tx note verification** — uses `getNotes({ txHash })` + `getTxReceipt` to verify the specific transaction created payment notes for the recipient
- **Anti-replay** — two-layer defense: nonce-based (middleware) + txHash set (facilitator)

### Bugs Fixed
- `mint_to_private` signature changed to `(from, to, amount)` in v0.87.9 — was missing `from` param
- `.simulate()` returns value directly in v0.87.9, not `{ result }` — all balance reads were showing `undefined`
- PXE note discovery — fixed by using `AztecAddress` objects and `registerSender`
- Balance verification — replaced total-balance threshold check with per-tx note verification to prevent pre-existing balance exploits

### What's Not Done
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
| Verification | PXE note discovery per-tx | getNotes({ txHash }) + getTxReceipt |
| Transfer function | transfer_private_to_private | transfer (renamed in v0.87.9, same semantics) |
| Facilitator | Server IS facilitator | Same — no separate service |
