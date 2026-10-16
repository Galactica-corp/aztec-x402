# Accepting the inference-money USDC: merchant guide

For merchants who already charge through aztec-x402 in a standard AIP-20 token and now want to accept the
inference-money USDC, either instead of AIP-20 or next to it.

The inference-money USDC is Ethereum USDC bridged to Aztec, held and spent privately. On chain it is the aztec-standards
Token plus a **merchant list**: an ordinary account (a *user*) may only pay a listed *merchant*. How the token and its
bridge work, every rule and refusal, and what each action makes public:
[inference-money `docs/integration.md`](https://github.com/Galactica-corp/inference-money/blob/main/docs/integration.md).
The SDK is [`@galactica-net/inference-money-core`](https://www.npmjs.com/package/@galactica-net/inference-money-core).

## What changes and what does not

Unchanged: the HTTP protocol (402, prepare, pay, retry), the middleware and the client packages, the route
configuration, and how a payment is verified (the token's completion log). A buyer infers the token kind from the
route's `asset`, so nothing extra goes into the 402.

New for the merchant:

1. **Your receiving account must be on the token's merchant list** (below). An unlisted account cannot even open a
   payment request, and buyers refuse to pay it.
2. **Your buyers need USDC on Aztec.** It cannot be minted or dripped; it only arrives over the bridge from Ethereum.
   If you have a front end, give it a deposit flow (below).
3. **Each request takes exactly one payment.** A second payment into the same request is refused, so buyers keep a
   record of what they paid (the SDK's `PaymentGate`).

## 1. Get your merchant account listed

1. **Use a dedicated Aztec account** for receiving payments (`payTo`). Deploy it as you do today.
2. **Bind it to your treasury first (recommended).** Make one small *private* deposit from your Ethereum treasury
   address to the account, and claim it. An account's first private claim binds it, for good, to the Ethereum
   address that made that deposit (its *funding address*). While listed, a merchant can withdraw anywhere; if it is
   ever switched off, it can withdraw only to its funding address. An account that is never bound can't withdraw
   after a switch-off. The listing CLI can't check binding, so do it before you ask for the listing. The deposit flow
   in section 4 does this.
3. **Ask the token's merchant admin to list the address.** On testnet the admin is Galactica: send them the
   account address. The admin runs `bun run bridge merchants add deployments/testnet.json <address>` in the
   inference-money repository. A listing takes effect at once.
4. **Check the listing.** The x402 server checks it at start and refuses to run when the account is not listed (see
   `assertCanSell` below). To check by hand: `merchantStatus(await syncMerchantList(node, token), account).merchant`
   from `@galactica-net/inference-money-core`.

A listing is permanent, but the admin can switch a merchant off. A switch-off takes effect after the entry's delay
(24 h on testnet). Requests opened before it stay payable until their stamp expires, 24 to 25 hours after they were
opened. After that the account is a user again: it can no longer receive private payments from users, nor pay users
back privately.

## 2. Server changes

### Dependencies

Take the aztec-x402 packages from the release that contains this integration (later than `1.2.0`), plus the SDK at
the exact version the x402 packages pin:

```sh
npm install @galactica-net/x402-agent @galactica-net/x402-mechanism @galactica-net/x402-middleware \
  @galactica-net/inference-money-core@0.3.0
```

The SDK pins its `@aztec-labs/*` dependencies exactly (`6.0.0-rc.3` for 0.3.0); use the same release everywhere in
your server, or the two copies of the SDK disagree about artifacts and addresses. Never set `SEED` in a process that
loads the SDK: importing it throws.

### Token addresses

Read the USDC address from the SDK; don't hardcode it. A redeploy changes the address, and a new SDK version ships it:

```ts
import { TESTNET_MANIFEST } from "@galactica-net/inference-money-core/deployments";

const USDC = TESTNET_MANIFEST.l2.token.address; // 6 decimals, like tUSDC
```

| Testnet (Aztec 6.0.0-rc.3, SDK 0.3.0) | Address |
|---|---|
| USDC (inference-money) | `0x23d496050d4e697a0c8960fdc54fbe4ec4cdbbfd8487d296ff7c79b90c950eb2` |
| tUSDC (AIP-20, faucet) | `0x08b5c7a74699f9336cb31f42872d9f067f52aef34afe2d2eb34dd0c3e3b36358` |
| Sponsored FPC (pays fees) | `0x2adfb70e860909f0db8268b3fec80bce52a94559963444f5c0341816b8412130` |
| Sepolia USDC (Circle) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| Bridge on Sepolia: portal, router | `TESTNET_MANIFEST.l1.portal`, `TESTNET_MANIFEST.l1.router` |

### Facilitator signer

The facilitator opens requests through a `TokenRegistry`. The registry reads each `asset`'s contract class from the
chain and picks the AIP-20 or inference-money adapter, so one signer serves both tokens. Copy
`packages/demo/src/aztec/facilitator-signer.ts` into your server (about 60 lines; it isn't published). Then call
`assertCanSell` for every asset at start:

```ts
import { createNodeClient, createPXEWallet, sponsoredFeePayment, TokenRegistry } from "@galactica-net/x402-agent/aztec";
import { ExactAztecFacilitatorScheme } from "@galactica-net/x402-mechanism/exact/facilitator";
import { RealFacilitatorAztecSigner } from "./facilitator-signer.js";

const node = createNodeClient("https://aztec-testnet.drpc.org"); // not createAztecNodeClient: see below
const wallet = await createPXEWallet(node, { pxe: { proverEnabled: true } });
const merchant = /* your listed account, loaded into `wallet` as today */;
const fee = { paymentMethod: await sponsoredFeePayment(wallet) };

const tokens = new TokenRegistry({ node, wallet, account: merchant.address, fee });
const signer = new RealFacilitatorAztecSigner(merchant, node, tokens);
for (const asset of [USDC /*, TUSDC */]) await signer.assertCanSell(asset); // throws merchant_not_listed
const facilitator = new ExactAztecFacilitatorScheme(signer, ["aztec:testnet"]);
await facilitator.initialize();
```

Always create node clients with `createNodeClient`. On the public dRPC testnet host it caps JSON-RPC batches at the
host's limit; without the cap, proving fails there.

### Routes

A 402 offers a single asset, so a route charges in exactly one token. You have two options:

- **Inference-money USDC only:** set every route's `asset` to `USDC`.
- **Both tokens:** give each token its own route, and let the client pick the route. Both can pay the same `payTo`.

```ts
const routes: RoutesConfig = {
  "/api/usdc/infer": { network: "aztec:testnet", asset: USDC, amount: "10000", payTo: MERCHANT, maxTimeoutSeconds: 600 },
  "/api/tusdc/infer": { network: "aztec:testnet", asset: TUSDC, amount: "10000", payTo: MERCHANT, maxTimeoutSeconds: 600 },
};
app.use(createPaymentMiddleware(routes, { facilitator }));
```

`amount` is in base units (6 decimals: `10000` is $0.01). Allow enough `maxTimeoutSeconds` for the buyer to prove on
their device; the demo uses 600 on testnet.

## 3. Buyer changes (x402 clients you ship)

A buyer that pays in USDC needs two things that AIP-20 didn't:

- **A wallet built through a payment gate**, which refuses a second payment into a request before proving it.
  `paymentGateFor(node, asset, store)` returns the gate for a USDC `asset`, and `undefined` for AIP-20.
- **A payment store that outlives the process.** Records must survive restarts and be shared by every process and tab
  that pays from the account. For Node use `filePaymentStore(path)`. In a browser, implement the SDK's `PaymentStore`
  interface (`locked`, `get`, `put`) on persistent storage. The default `memoryPaymentStore` forgets on exit.

```ts
import { createPXEWallet, filePaymentStore, paymentGateFor, RealClientAztecSigner, TokenRegistry } from "@galactica-net/x402-agent/aztec";

const gate = await paymentGateFor(node, USDC, () => filePaymentStore("./requests.json"));
const create = (n) => createPXEWallet(n, { pxe: { proverEnabled: true } });
const wallet = gate ? await gate.bindWallet(create) : await create(node);
const tokens = new TokenRegistry({ node, wallet, account: buyer.address, fee, paymentGate: gate });
const fetchWithPayment = wrapFetchWithPayment(fetch, new ExactAztecClientScheme(new RealClientAztecSigner(buyer, tokens)));
```

The signer checks `payTo` before asking you to prepare: an unlisted payee is refused with `merchant_not_listed`.
Nothing is opened or paid in that case. The `aztec-x402` agent CLI does all of this already. `PXEWallet` builds on
the Node embedded wallet; a browser buyer needs a browser wallet with the same gate and adapters, which has not been
tested here.

## 4. Front end: deposit USDC from Ethereum, then pay

A user starts with USDC on Ethereum and an Aztec account in the browser. The flow has two parts.

### 4a. Deposit and claim

Everything comes from `@galactica-net/inference-money-core`, with the manifest from `…/deployments`. The L1 context
is `{ publicClient, walletClient, account }` (viem) for the user's connected Ethereum wallet. The inference-money
showcase implements this flow, including recovery: `apps/showcase/src/live/actions.ts` in the
[inference-money repository](https://github.com/Galactica-corp/inference-money).

1. **Check the network.** `assertNetworkIdentity(node, publicClient, manifest)` confirms the node and the portal are
   on the manifest's network, and returns `depositsOpen` (false after an Aztec rollup upgrade stopped deposits). The
   user's Ethereum wallet then asks for up to three confirmations: the USDC approval for Permit2 (first deposit
   only), the deposit's typed-data signature, and the deposit transaction.
2. **Permit2 approval (once per Ethereum address).** Call `ensurePermit2Allowance({ allowance, approveMax,
   waitReceipt, needed })` for USDC towards `manifest.l1.permit2`.
3. **Prepare.** Call `prepareDeposit({ amount, recipient: userAztecAddress, kind: "private" }, manifest,
   () => l1Timestamp)`. **Store the draft durably now.** It holds the only copy of the claim salt, and without it the
   deposit can't be claimed. Keep drafts and tickets for good, and never delete them.
4. **Sign and send.** Call `submitDeposit(draft, l1, manifest, node, onStage)`. The user signs the Permit2 typed data,
   and their wallet sends the deposit to the router (it must be the signer's own transaction). Then `confirmDeposit(draft, l1, manifest)` returns a `ClaimTicket`:
   store it.
5. **Binding consent.** `claimBinding(wallet, manifest, recipient, ticket.depositor)` returns `"binds"` on the
   account's first claim. Show something like "This binds your Aztec account to 0x… for good: you can withdraw only
   to this address", and continue only if the user agrees.
6. **Wait and claim.** Call `waitClaimable(ticket, node, wallet, manifest, recipient, onWait, { allowBind: true })`,
   then `claim(ticket, node, wallet, manifest, { from: recipient, allowBind: true })`. The fee goes through the
   sponsor by default, which keeps the claim private. On testnet the L1→L2 message takes several minutes; show
   progress (`onStage` / `onWait`, `depositStatus`). Pass `wait: L2_PROPOSED` to answer about a minute earlier.
7. **Show the balance.** Call `l2UsdcBalance(wallet, manifest, recipient, "private")`.

Things a deposit UI must handle:

- **Only externally owned accounts (EOAs) can sign the private deposit.** A contract wallet (Safe, 4337) gets
  `KeyHolderRequiredError`. Its owner EOA deposits instead, or you use the portal's signed path (see "Depositing
  without the router" in the integration doc).
- **Users can only receive private deposits,** and only from their funding address once bound. A deposit from
  another Ethereum address can't be claimed; it can only be returned to the depositor.
- **Recovery after a reload or a lost response:** `reconcileDeposit(draft, l1, manifest)` finds a sent deposit's
  ticket (or `"pending"` / `"not-deposited"`). `claim` returning `"consumed-unknown"` means the deposit was already
  claimed or returned; `depositFate` tells which.
- **Typed errors,** to map to messages: `PublicDepositToUserError`, `NotFundingAddressError`,
  `BindConsentRequiredError`, `SponsorUnavailableError`, `NetworkMismatchError`, and the router's `ZeroAmount` /
  `AmountExceedsL2Max` / `RollupNotCanonical`.

### 4b. Pay your merchant address over x402

Once the claim lands, the user's private balance pays your routes like any x402 payment (section 3). For your UI:

- **Pay right after preparing.** A user may only pay into a request opened for a merchant, until its stamp expires
  (24 h). The SDK also refuses (`stale`) a private payment through a stamp older than about an hour, so don't hold
  prepared requests.
- **`payment_refused` means don't pay again.** The request was already paid or a payment is in flight. Check the
  user's history, or start a fresh request.
- **Withdrawals.** A user can withdraw back to Ethereum only to their funding address (`exitToL1`, then
  `finishWithdrawal` once the epoch is proven). Your own merchant account can withdraw to any address while listed
  (`asMerchant: true`).

## 5. Errors your users or logs will see

| Code (x402 agent / CLI) | Meaning | What to do |
|---|---|---|
| `merchant_not_listed` | The `payTo` (or your server, at start) is not on the merchant list | Get the account listed; check `payTo` |
| `payment_refused` | This request was already paid or is being paid (`reason`: `paid`, `in-flight`, `completed-on-chain`, `stale`, `replaced`) | Don't pay again; open a fresh request if nothing was delivered |
| `token_refused` | The token contract refused (`rule` names it, e.g. "users may only pay into requests opened for a merchant") | Report; usually a listing or stamp problem |
| `unsupported_token` | The `asset` is not an AIP-20 or inference-money token | Fix the route's `asset` |
| `token_not_found` | No contract at `asset` on this network | Check the address, and the SDK version that ships it |

All refusal strings: "Refusals" in the [integration doc](https://github.com/Galactica-corp/inference-money/blob/main/docs/integration.md#refusals).

## 6. Privacy notes for merchants

- **Your prices are public, so the amount of a payment usually identifies you as its recipient.** Avoid unique
  prices if that matters to you.
- **Use the sponsor for fees** (as above). An account that pays its own fees is named as fee payer in public.
- **Keep request commitments out of logs and URLs.** Anyone who knows a commitment can tell whether it was paid and
  by which account.
- **A user's first private payment to you announces you as their payee once,** under a tag derived from your
  address. Later payments between the same two accounts reveal nothing new.
- **The merchant list is public.**

The full list: "What each action makes public" in the integration doc.

## 7. Checklist

- [ ] Receiving account deployed, bound to your treasury, and listed by the merchant admin.
- [ ] `@galactica-net/inference-money-core` and `@aztec-labs/*` pinned to the versions the x402 packages use; no `SEED`.
- [ ] USDC address read from `TESTNET_MANIFEST`; one route per token.
- [ ] Facilitator signer through `TokenRegistry`; `assertCanSell` for every asset at start; `createNodeClient`.
- [ ] Buyers you ship pay through a `PaymentGate` with a persistent store.
- [ ] Front end: deposit with stored drafts and tickets, binding consent, claim with progress and recovery.
- [ ] Tested on a local network first: `bun run setup:sandbox:inference` and `bun run e2e:sandbox` in this
  repository ([readme](../readme.md)).
