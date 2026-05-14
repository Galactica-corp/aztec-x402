# Commitment Pattern Investigation - Findings

**Date:** 2026-05-14
**Branch:** `feat/offchain-partial-notes`
**Status:** Unblocked on Aztec public testnet with Aztec `4.2.0` and `@defi-wonderland/aztec-standards@4.2.0`.

## TL;DR

The original blocker is gone. AIP-20 now exposes `initialize_transfer_commitment(to, completer)`, so the server can prepare a partial note for itself and bind completion to the client address. The demo uses the published Wonderland package directly; there is no local contract fork, checked-in Noir source, or copied token artifact.

The live x402 flow works on public testnet:

1. Server returns a 402 challenge with a nonce.
2. Client prepares by sending `{ nonce, senderAddress }`.
3. Server submits an Aztec prepare transaction that creates the commitment.
4. Client finalizes the private transfer to that commitment.
5. Server verifies the finalized tx, amount delta, nonce, sender, token, and commitment before returning the protected response.

## What Changed Since the Old Devnet Blocker

The March investigation was based on older devnet behavior and a local token fork. That is obsolete.

Current state:

| Component | Status |
|---|---|
| Aztec SDK | `4.2.0` |
| Public testnet | `4.2.0` |
| Token contract | Published AIP-20 token from `@defi-wonderland/aztec-standards@4.2.0` |
| Local contract fork | Removed |
| Testnet x402 happy path | Working |

## Why the Commitment Pattern Matters

Direct private transfer verification can prove that a transaction happened, but it is hard to prove that the private payment went to the expected server. The commitment pattern moves that guarantee into the transfer shape:

- the server creates the partial note with `to = serverAddress`;
- the client is the only allowed completer;
- the client cannot redirect that commitment to another recipient.

That gives structural recipient verification instead of relying on "the client says they paid the server".

## Current Verification Posture

The implementation now fails closed for payment verification:

- unknown, expired, malformed, or mismatched commitments are rejected;
- sender, token, nonce, and commitment must match the prepare phase;
- finalized transactions must have an acceptable status, private note hashes, and commitment-finalization nullifiers;
- amount verification uses the server private balance delta;
- transient RPC/PXE failures do not consume the local nonce/commitment immediately, so the client can retry the same proof.

Because the current stable tx effects do not expose a public commitment-to-note-value mapping, the demo serializes pending commitments to avoid concurrent balance-diff ambiguity. That is a throughput limitation, not a hidden concurrent verifier.

## Remaining Limitations

- Prepare is an on-chain action paid by the server, so production deployments need rate limits and sender attestation before exposing it broadly.
- The demo facilitator is merchant-hosted. A third-party facilitator would need delegated ability to create commitments for the merchant Aztec account.
- The amount check should move from balance-diff to direct note/value inspection when the required PXE/NoteStore API is stable and public.

## Useful Artifacts

- Main flow: `readme.md`
- Middleware nonce/prepare lifecycle: `packages/middleware/src/middleware.ts`
- Facilitator commitment binding: `packages/mechanism/src/exact/facilitator/scheme.ts`
- Real Aztec verifier: `packages/demo/src/aztec/facilitator-signer.ts`
