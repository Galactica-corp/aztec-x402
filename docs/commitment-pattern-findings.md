# Commitment Pattern Investigation — Findings

**Date:** 2026-03-14
**Branch:** `feat/wonderland-direct-transfer`
**Status:** Solved with custom token contract fork. Blocked on devnet until v4.0.4 upgrade.

## TL;DR

The official Aztec TokenContract v4.0.4 hardcodes `completer = msg_sender()` in `prepare_private_balance_increase`, preventing cross-party commitment flows where the server prepares and the client finalizes.

**Solution:** A one-line fork of the token contract that accepts an explicit `completer` parameter. This is safe — the completer can only send tokens FROM their own balance TO the address bound in the partial note.

**Blocker:** The commitment pattern works on local sandbox (v4.0.4) but not on devnet (`4.0.0-devnet.2-patch.1`) due to a PXE nullifier witness bug fixed in v4.0.4. Devnet upgrade expected in ~2 weeks.

## Background

We need the commitment pattern for **structural recipient verification**: if the server creates a partial note bound to its own address, the client can only complete the transfer TO the server. This closes the "who did the payment go to?" verification gap.

## Investigation Timeline

### Phase 1: Testing standard contracts

| Environment | SDK Version | Contract | Result |
|---|---|---|---|
| Devnet | `4.0.0-devnet.2-patch.1` | Wonderland `@defi-wonderland/aztec-standards` | Nullifier witness not found |
| Devnet | `4.0.0-devnet.2-patch.1` | Official `@aztec/noir-contracts.js` | Nullifier witness not found |

Initial diagnosis: the error occurs because the standard token contract binds `completer = msg_sender()` during prepare. When server (Bob) prepares and client (Alice) finalizes, the nullifier hash mismatches (Bob != Alice).

### Phase 2: Custom token contract fork

We forked the official v4.0.4 token contract with one change:

```diff
- fn _prepare_private_balance_increase(to: AztecAddress) -> PartialUintNote {
-     UintNote::partial(to, slot, context, to, self.msg_sender())
+ fn _prepare_private_balance_increase(to: AztecAddress, completer: AztecAddress) -> PartialUintNote {
+     UintNote::partial(to, slot, context, to, completer)
  }
```

Compiled with `aztecprotocol/aztec:4.0.4` Docker image (`nargo compile` + `bb aztec_process`).

### Phase 3: Devnet testing

| SDK Version | Node Version | Result |
|---|---|---|
| `4.0.4` | devnet (`4.0.0-devnet.2-patch.1`) | "Incorrect verification keys tree root" — VK tree mismatch |
| `4.0.0-devnet.2-patch.1` | devnet | prepare succeeds, finalize fails: "Nullifier witness not found" |

The devnet has a PXE/simulator bug where `utilityGetNullifierMembershipWitness` cannot find the nullifier created by partial note prepare. This bug was fixed in the v4.0.4 SDK (PRs below), but the devnet node hasn't upgraded.

Using the v4.0.4 SDK with the devnet node fails because the protocol's verification key tree root changed between versions — account deployment is rejected.

**Conclusion:** The commitment pattern cannot work on devnet until both the SDK and node are at v4.0.4+.

## Root Cause — Standard Contract Limitation

From the v4.0.4 token contract source (`main.nr`):

```rust
fn _prepare_private_balance_increase(to: AztecAddress) -> PartialUintNote {
    let partial_note = UintNote::partial(
        to,
        self.storage.balances.get_storage_slot(),
        self.context,
        to,                  // owner
        self.msg_sender(),   // completer = whoever calls prepare
    );
    partial_note
}
```

The validity commitment hash **includes the completer's identity** (introduced in PR [#14379](https://github.com/AztecProtocol/aztec-packages/pull/14379)). The prepare step stores `completer = msg_sender()`, and finalize recomputes the hash using its own `msg_sender()`. If they differ, the nullifier lookup fails.

### Our x402 flow vs what the standard contract expects

```
Standard contract (broken for x402):
  Bob (server)  calls prepare(bob)    → completer = Bob
  Alice (client) calls finalize(...)  → checks completer = Alice
  → Bob != Alice → nullifier hash mismatch

Our fork (works):
  Bob (server)  calls prepare(bob, alice)  → completer = Alice
  Alice (client) calls finalize(...)       → checks completer = Alice
  → Alice == Alice → succeeds
```

## Security Assessment of the Fork

The `completer` parameter only controls who is authorized to call finalize for that specific partial note. The completer:
- Can only send tokens FROM their own balance
- Can only send TO the address specified in `to` (cryptographically bound in the partial note)
- Cannot steal tokens — they can only choose to complete or not
- Cannot change the recipient — it's bound at prepare time

The rest of the token contract (minting, balances, transfers, admin) is untouched.

## Upstream PRs Investigated

| PR | Date Merged | What It Does | In v4.0.4? |
|---|---|---|---|
| [#14379](https://github.com/AztecProtocol/aztec-packages/pull/14379) | 2025-05-21 | Added completer identity to validity commitment hash | Yes |
| [#14432](https://github.com/AztecProtocol/aztec-packages/pull/14432) | 2025-05-27 | Moved validity commitment from public storage to nullifier tree | Yes |
| [#14533](https://github.com/AztecProtocol/aztec-packages/pull/14533) | 2025-06-03 | Implemented private-to-private partial note completion | Yes |
| [#12391](https://github.com/AztecProtocol/aztec-packages/pull/12391) | Earlier | Partial notes system redesign | Yes |

All PRs are in v4.0.4 (tagged 2026-02-27). The nullifier witness bug on devnet is in the PXE/simulator, not in the contract — v4.0.4 SDK has the fix.

## Current Status

- **Custom contract**: compiled, artifact checked in, TypeScript wrapper at `@aztec-x402/contracts/Token`
- **Local sandbox (4.0.4)**: ready for testing the full commitment flow
- **Devnet**: blocked until node upgrades to 4.0.4+ (~2 weeks)
- **Fallback**: `transfer_in_private` (direct transfer) works on devnet but lacks structural recipient verification

## Artifacts

- Forked contract source: `packages/contracts/token/src/main.nr`
- Compiled artifact: `packages/contracts/token/target/token_contract-Token.json`
- TypeScript wrapper: `packages/contracts/src/Token.ts`
- Phase 0 test script: `packages/demo/src/aztec/test-wonderland-commitment.ts`
