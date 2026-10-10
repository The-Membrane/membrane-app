# STATE-MATRIX — the states this app has not decided yet

Companion to `tools/ui-sensory/UI-SENSING.md` (how to instrument),
`tools/ui-sensory/FLOWS.md` (which journeys to walk) and `.claude/sensors.json`
(what exists, how to bring it up). Those three describe **sensing**. This file is
**design input**: it makes every non-happy-path cell visible so you can decide
each one on purpose instead of inheriting whatever the code already does.

**This is not a bug list.** Nothing here is filed as a defect. The premise is
that most DeFi UX pain comes from *undesigned* states rather than ugly ones — a
design specifies the happy path and goes quiet on loading, empty, error, stale,
disconnected, wrong-chain, over-max, pending, failed. Those silences get filled
by whatever `||` or early-return the implementer reached for that day, and they
survive every restyle because a restyle never sees them.

**Method.** Source-read only — no browser was driven. Every behavioral claim
carries `file:line`. Where a conclusion is *inferred* (traced through code but
not observed running) it says so inline. Cells that source cannot settle are
listed in §5.

---

## 0. The three classifications, and why one of them matters most

| | meaning |
|---|---|
| **DESIGNED** ✅ | an explicit, distinct, intentional-looking treatment for this state |
| **DEFAULTED** ⚠️ | renders *something*, but by accident of code shape — a product decision nobody made |
| **MISSING** ❌ | no handling: blank, crash, or a spinner that never ends |
| **N/A** — | the state cannot occur on this surface |

**DEFAULTED is the output worth reading.** A MISSING cell announces itself the
first time you hit it. A DEFAULTED cell renders confidently and lies. In this
app that shape recurs about a dozen times and it always resolves the same
direction — *toward looking fine*:

```
query fails  ──►  data undefined  ──►  `|| 0`  ──►  renders "0"  ──►  styled green
query fails  ──►  returns null    ──►  `?? []` ──►  "No deposits found"
query pending ──► length === 0    ──►  "Loading available collateral…"  (forever)
no wallet    ──►  no user         ──►  getMockRevenue()  ──►  "$463.50"
LTV unknown  ──►  liqLTV === 0    ──►  health = 100      ──►  "maximally safe"
```

For a lending protocol that direction is exactly backwards. Every one of those
is a design decision available to you today; the code has just already answered
them.

---

## 1. Surfaces audited (14), with maturity

Maturity matters more than the matrix for four of these. Auditing a scaffold's
error states as if it were finished is noise, so each row is labelled.

| # | Surface | Route | Maturity |
|---|---|---|---|
| S1 | **Global shell** — nav, RPC banner, toaster, query defaults | all | shipped |
| S2 | Home (cyberpunk landing) | `/ethereum` | shipped, **chain-free** |
| S3 | About | `/ethereum/about` | shipped, static |
| S4 | **Mint — read side** (Available Collateral / to Borrow / to Lend, Currently Lent, Liquidation Simulator) | `/ethereum/mint` | shipped |
| S5 | **Mint — position side** (Position Overview, Perf Chart, Collateralized Bundle, Debt Card) | `/ethereum/mint` | shipped, data source **stubbed** |
| S6 | **Deposit modal** | `/ethereum/mint` | shipped |
| S7 | **Borrow modal** | `/ethereum/mint` | shipped, **inert in prod** (see U7) |
| S8 | **Repay modal** | `/ethereum/mint` | shipped |
| S9 | **Liquidate / bid queue** | `/ethereum/liquidate` | **half-migrated** — real EVM writes, dead Cosmos reads |
| S10 | The Disco | `/ethereum/disco` | 🏗 **scaffold** — 100% mock, hardcoded flag |
| S11 | Portfolio | `/ethereum/portfolio` | 🏗 **scaffold** — mock-first, not in nav |
| S12 | Membrane dashboard | `/ethereum/membrane-dashboard` | 🏗 **scaffold** — 100% mock |
| S13 | LTV dashboard | `/ethereum/ltv-dashboard` | 🏗 **scaffold** — static mock, no live path exists |
| S14 | Acquisition dashboard | `/ethereum/acquisition-dashboard` | 🏗 **scaffold** — ~90% mock + one permanently-disabled query |

Nav ground truth: 8 live destinations — About, Home, Mint, The Disco, Liquidate,
plus a Dashboards group of Acquisition / LTVs / Membrane
(`components/HorizontalNav.tsx:13-35`). Portfolio is commented out at `:17` and
is direct-URL only.

> **Read the maturity column before the matrix.** Five of the fourteen surfaces
> (S10–S14) are mock scaffolds behind hardcoded `const USE_MOCK_DATA = true`
> flags — `services/disco.ts:24`, `services/acquisition.ts:7`,
> `hooks/useMembraneDashboard.ts:16`, `services/manic.ts:51`,
> `services/systemDiscounts.ts:7`, `services/cdp.ts:675`. Their state cells are
> mostly *unreachable today*, which is fine — but see **P5**, because those flags
> are not environment-gated and therefore ship.

---

## 2. The matrix

### 2A — Data states

| Surface | pending | error / RPC dead | success-but-empty | partial | stale / refetching |
|---|:--:|:--:|:--:|:--:|:--:|
| S1 shell | — | ✅ banner (60s lag) | — | — | ❌ |
| S2 home | — | — | — | — | — |
| S3 about | — | — | — | — | — |
| S4 mint read | ⚠️ | ❌ | ⚠️ | ⚠️ | ❌ |
| S5 mint position | ✅ skeleton | ❌ | ⚠️ absent from DOM | ⚠️ | ❌ |
| S6 deposit modal | ✅ spinner | ⚠️ (write only) | — | ⚠️ | ❌ |
| S7 borrow modal | ✅ spinner | ⚠️ (write only) | — | ⚠️ | ❌ |
| S8 repay modal | ✅ spinner | ⚠️ (write only) | — | ⚠️ | ❌ |
| S9 liquidate | ❌ | ❌ | ⚠️ **reads as "safe"** | ⚠️ | ❌ |
| S10 disco 🏗 | ⚠️ widget-level only | ❌ | ⚠️ | ⚠️ | ❌ |
| S11 portfolio 🏗 | ❌ | ❌ | ⚠️ **fabricates** | ⚠️ | ❌ |
| S12 membrane 🏗 | ✅ skeleton | ❌ | ⚠️ same skeleton | ⚠️ | ❌ |
| S13 ltv 🏗 | ❌ | ❌ | ✅ (dead code) | — | ❌ |
| S14 acquisition 🏗 | ⚠️ `"Loading..."` text | ❌ | ⚠️ sections vanish | ⚠️ | ❌ |

**The column that is entirely one colour is `error`.** No surface in this app
consumes `isError` on a data-read path. Confirmed independently on all four
audit passes; `components/RPCStatus.tsx` is the single exception and it is an
infrastructure banner, not a per-surface treatment.

### 2B — Wallet, input, transaction, first-run

| Surface | disconnected | wrong-chain | no position | insufficient / over-max | zero / invalid | would-breach-LTV | tx pending | tx simulate-fail | tx rejected | tx reverted | tx success | first-run |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| S1 shell | ✅ Connect btn | ❌ | — | — | — | — | — | — | — | ⚠️ | ⚠️ | — |
| S2/S3 | — | — | — | — | — | — | — | — | — | — | — | — |
| S4 mint read | ⚠️ | ❌ | ⚠️ | — | — | — | — | — | — | — | — | ⚠️ |
| S5 mint position | ⚠️ hidden | ❌ | ⚠️ hidden | — | — | — | — | — | — | — | — | ❌ |
| S6 deposit | ⚠️ dead CTA | ❌ | — | ✅ message | ⚠️ silent | — | ✅ | ✅ raw string | ⚠️ | ⚠️ | ⚠️ | ⚠️ |
| S7 borrow | ⚠️ dead CTA | ❌ | — | ⚠️ silent clamp | ⚠️ silent | ⚠️ **clamp only** | ✅ | ✅ raw string | ⚠️ | ⚠️ | ⚠️ | ⚠️ |
| S8 repay | ⚠️ dead CTA | ❌ | — | ⚠️ silent clamp | ⚠️ silent | — | ✅ | ✅ raw string | ⚠️ | ⚠️ | ⚠️ | — |
| S9 liquidate | ⚠️ silent disable | ❌ | ⚠️ | ⚠️ silent clamp | ⚠️ silent | — | ✅ 2-phase | ✅ `TxError` | ⚠️ | ⚠️ | ⚠️ | ⚠️ |
| S10 disco 🏗 | ⚠️ **fake portfolio** | ❌ | ⚠️ | ❌ | ⚠️ silent | — | ✅ | ❌ | ⚠️ | ⚠️ | ⚠️ | ⚠️ |
| S11 portfolio 🏗 | ⚠️ **fabricates** | ❌ | ⚠️ **fabricates** | — | — | — | — | — | — | — | — | ⚠️ |
| S12–S14 🏗 | — wallet-free | — | — | — | — | — | — | — | — | — | — | ⚠️ |

Wrong-chain is `❌` on every row for one reason: `hooks/useWallet.ts:31` sets
`isWalletConnected` straight from wagmi's `useAccount().isConnected` with no
chain comparison, and `components/WallectConnect/WalletConnect.tsx` is a custom
button using only RainbowKit's `useConnectModal` — so RainbowKit's built-in
wrong-network UI never mounts. The only `chainId !==` in the repo
(`components/RPCStatus.tsx:17`) compares the *app's own RPC* to the expected
chain, not the user's wallet.

---

## 3. The ten highest-impact undesigned cells

Ranked by consequence to a user with money in the protocol, not by how broken
the code looks. Each carries evidence, why it matters *here*, and options —
these are decisions for you, not prescriptions.

---

### U1 · A reverted transaction reports as success and clears the form
**Surface:** every write path (S6–S10) · **State:** tx reverted on-chain

**Today.** `hooks/useTransaction.ts:63-68` inspects the receipt, sets `code = 1`
on `receipt.status !== 'success'` — and does **not throw**. The mutation resolves,
so react-query runs the *success* callback: `useTransaction.ts:73-83` calls
`toaster.success({ message: 'Transaction ' + (code === 0 ? 'Successful' : 'Failed') })`.
A green success-styled toast whose body text reads "Transaction Failed."
Then `onSuccess?.()` fires unconditionally at `:85` — for a deposit that means
`onClose()` + `reset()` (`components/NeutronMint/DepositModal.tsx:67-70`) plus
`invalidateQueries` (`hooks/useDepositTransaction.ts:80-85`); for a bid it resets
the inputs (`components/Bid/PlaceBid.tsx:23-24`). The modal closes and the form
empties exactly as it would on a real success.

**Why it matters here.** This is the one state where the user has already spent
gas and signed. They watch the modal close and the form reset — the universal
"it worked" choreography — and their position is unchanged. On a partial
multi-call flow it is worse: `useTransaction.ts:50-69` signs `approve` then
`deposit` as separate prompts and `break`s on the first failed receipt, so the
user can end up having granted an ERC-20 allowance with no deposit, and still see
the success choreography.

**Options.**
- **(a) Throw on `code === 1`** so the existing `onError` path owns it — one line, gets a red toast, but the copy stays generic.
- **(b) Make reverted a first-class state**: keep the modal open, swap its body to a failure panel with the tx hash and the decoded reason, offer "Try again". Highest cost, only design that lets the user recover in place.
- **(c) Split the multi-call flow into visible steps** (Approve → Deposit) with per-step status, so a half-completed sequence is legible instead of invisible.

---

### U2 · When the app doesn't know your LTV, it renders "100% healthy"
**Surface:** S5, S6, S7, S8 · **State:** data pending / error / stubbed

**Today.** `components/NeutronMint/hooks/useBorrowModal.ts:76-79`:

```ts
const liquidationLTV = finalVaultSummary.liqudationLTV || 0
const health = liquidationLTV > 0
    ? Math.max(0, 100 - (ltv / liquidationLTV) * 100)
    : 100                       // ← "unknown" resolves to "maximally safe"
```

Identical shape at `useDepositModal.ts:73-75` and `useRepayModal.ts:70-72`. The
upstream source is currently an honest-zero stub — `components/Mint/hooks/useVaultSummary.ts:53-55`
returns `maxMint: 0, liquidValue: 0, liqudationLTV: 0` unconditionally, with a
candid comment at `:6-17` explaining the basket aggregate isn't available yet.
So today the ternary always takes the `: 100` branch. Related:
`components/NeutronMint/DebtCard.tsx:34-42` computes
`isBorrowDisabled = maxBorrowLtv > 0 && currentLtv >= maxBorrowLtv`, which with a
zero `maxBorrowLtv` is permanently `false` — the LTV guard is silently inert.

**Why it matters here.** Health is the single number a borrower checks before
deciding whether to add collateral. The fallback direction is the dangerous one:
absence of data reads as *safety*. A borrower two points from liquidation and a
borrower whose oracle query 500'd see the same reassuring figure.

**Options.**
- **(a) Fail loud in the risk direction** — `health = 0` / red / "at risk" when inputs are unknown. Alarming and wrong sometimes, but errs toward the user checking.
- **(b) Introduce a real `unknown` value** and render `—` with a "couldn't read liquidation LTV" note; suppress the health ring rather than drawing a full one.
- **(c) Gate the whole panel** — if the risk inputs are unknown, don't render a risk panel at all; show a single "position data unavailable" card. Blunt, but nothing can be misread.

Whatever you choose, it should be the same rule in all four hooks — see **P4**.

---

### U3 · Portfolio fabricates $463.50 for an empty, disconnected, or failed state
**Surface:** S11 · **State:** disconnected · empty · error · first-run (all four)

**Today.** `services/portMetrics.ts:141-142` returns `getMockRevenue()` when
`!client || !user`, and `:154-156` returns it *again* when a real connected user's
revenue sums to zero. `getMockRevenue()` (`:105-130`) is a fixed
$250.75 + $125.50 + $87.25 = **$463.50** with a derived revenue-per-second.
`components/Portfolio/PortPage/hooks/usePortMetrics.ts:28` keys the query on
`address || 'mock-user'`, so the query is always enabled and never gated. Nothing
in `components/Portfolio/PortPage/` consumes `isError` or `isLoading`; a first-run
wallet with nothing in it sees the same $463.50 as an anonymous visitor.

**Why it matters here.** This is the surface a user opens to answer "what have I
earned." Four genuinely different answers — *not connected*, *nothing yet*,
*couldn't load*, *here's your yield* — collapse into one confident dollar figure
that is false in three of them. It is also the only cell in this audit where the
app invents a number about the user's own money.

**Options.**
- **(a) Delete the mock fallback and design the empty state** — the honest three-way split (connect / nothing yet / couldn't load) is maybe three small components.
- **(b) Keep the mock but brand it** — a persistent "Demo data" chip and a muted palette, so it can never be mistaken for a balance. Cheap; keeps the surface demo-able.
- **(c) Hide the surface until it's real** — it isn't in the nav anyway (`HorizontalNav.tsx:17`), so shipping it half-fake costs more credibility than it buys.

---

### U4 · A disconnected wallet gets a dead button and no way to know why
**Surface:** S6, S7, S8 · **State:** wallet disconnected

**Today.** Three independent gates converge on the same silence:
`hooks/useDepositTransaction.ts:77` sets `enabled: enabled && !!address && !!cdpAddr && depositAmount > 0`;
`hooks/useSimulate.ts:126` adds `&& isWalletConnected`; and when disabled the
query resolves to `undefined` rather than erroring (`useSimulate.ts:59-60`), so
`isError` is false, `isLoading` is false, and `data` is undefined. That lands in
`components/NeutronMint/DepositModal.tsx:74`:

```ts
const isDisabled = depositAmount <= 0 || depositAmount > walletBalance
                 || simulate.isError || !simulate.data
```

Four distinct causes, one grey button. The one message that exists is suppressed
in exactly this case: `components/NeutronMint/DepositModalControls.tsx:152-156`
renders "Insufficient {symbol} balance" only when `walletBalance > 0`, and a
disconnected wallet has balance 0. There is no connect affordance inside any mint
modal — they use plain Chakra `<Button>`, never `TxButton` (verified: `TxButton`
is imported by ~30 components, none in `components/NeutronMint/`).

The app *has* the designed answer for this and it is switched off:
`pages/[chain]/mint/index.tsx:11-18` has the wallet gate commented out, and the
component it would render, `components/Mint/LockedAccess.tsx:13`
("Connect your wallet to access."), is the only explicit connect-copy in the app.

**Why it matters here.** Connecting a wallet is the first thing a new user must
do and the app never asks. Worse, wrong-chain lands in the identical dead state
by a different route — `getContractAddress` returns `undefined` for an unknown
chain id (`config/evm/contracts.ts:38-39`), so `!!cdpAddr` fails and the button
greys out with no hint that the network is the problem.

**Options.**
- **(a) Re-enable a route-level gate** — restore `LockedAccess` on `/mint`. Simplest; costs the anonymous browsing that the wallet-independent read path was built for (`services/chain/client.ts:6-9`).
- **(b) Gate at the CTA** — swap each modal's button to `TxButton` so it relabels to "Connect to Ethereum" in place. Preserves browsing, makes the boundary local and consistent with `/liquidate`.
- **(c) Make the disabled reason explicit** — replace the boolean `isDisabled` with a `reason` enum (`'no-wallet' | 'wrong-chain' | 'no-amount' | 'insufficient' | 'would-revert' | 'simulating'`) rendered as one line under the button. Most work, and it also solves U5 and P2.

---

### U5 · Wrong-chain does not exist as a state anywhere in the app
**Surface:** all wallet-touching (S1, S6–S10) · **State:** connected, wrong network

**Today.** `hooks/useWallet.ts:31` exposes only `isConnected` — no `chainId`, no
`switchChain`. `components/TxButton.tsx:29-31` branches solely on
`!isWalletConnected`. `components/WallectConnect/WalletConnect.tsx` is a custom
button over `useConnectModal`, so RainbowKit's default wrong-network chip never
renders. Repo-wide, `useSwitchChain` / `useChainId` / `chainId !==` return one
hit: `components/RPCStatus.tsx:17`, about the app's own RPC.

**Why it matters here.** The app targets a local anvil (31337). Wallets default
to mainnet. So the *most likely* first state for any real user — and the common
dev case — is "connected, wrong chain," and its rendering is byte-identical to
"connected, correct chain, nothing to show": zeros, greys, dead buttons.

**Options.**
- **(a) One global bar** — a persistent "Wrong network — switch to Ethereum (31337)" strip with a `switchChain` button, mounted next to `RPCStatus` in `components/Layout.tsx:92`. One decision, covers every surface.
- **(b) Per-CTA takeover** — `TxButton` grows a third branch that relabels to "Switch network" and calls `switchChain`. Keeps the fix where the action is.
- **(c) Adopt RainbowKit's `ConnectButton.Custom`** so the connected/wrong-network/connecting states come from the library and you only style them.

---

### U6 · "Loading available collateral…" is the app's word for four different things
**Surface:** S4 · **State:** pending · error · empty · (and no-chain)

**Today.** `components/NeutronMint/hooks/useCollateralRows.ts:26` is
`if (!basketData || !basketAssetsData || !pricesData) return []` — pending, failed
and genuinely-empty all produce the same `[]`. That falls into
`components/NeutronMint/AvailableCollateral.tsx:53-63`, whose only branch is
`if (collateralRows.length === 0)` and whose only copy is
**"Loading available collateral…"** — permanently. `CollateralizedBundle.tsx:31-38`
has the same collapse.

Two silent-substitution lines sit alongside it: `useCollateralRows.ts:42`
(`pricesByDenom.get(denom) || 0` — a missing price becomes $0) and `:47` (a
missing rate becomes 0% APY).

**Why it matters here.** This is the entry point to the entire protocol — the
list of what you can deposit. If the RPC is down the user waits forever on a
string that promises progress. And the global banner does not rescue them:
`components/RPCStatus.tsx:20-21` polls at 60s with `retry: 1`, so a mid-session
node death is invisible for up to a minute, and the banner is an inline
`<Alert>` inside `<main>` (`components/Layout.tsx:92`) that pushes content and
lets the page keep rendering $0 prices and 0% APYs underneath it.

**Options.**
- **(a) Split the hook's return** into `{ rows, status }` so the component can render three branches — spinner, "no collateral is currently listed", and an error card with a retry.
- **(b) Escalate the banner** — make RPC-unreachable a blocking overlay (or at minimum drop the poll interval and add a manual retry), on the reasoning that no number on the page is trustworthy while it's showing.
- **(c) Render unknown prices as `—`, never `$0`** — decide this globally (see **P4**), because `$0` on a collateral row is a statement about an asset's value.

---

### U7 · The borrow input silently clamps to zero, so the flow is mute-dead
**Surface:** S7 · **State:** would-breach-LTV / exceeds max

**Today.** `components/NeutronMint/hooks/useBorrowModal.ts:41-46` computes
`maxBorrowable = max(0, maxMint − debtAmount)`, and `maxMint` is the hardcoded
`0` from `components/Mint/hooks/useVaultSummary.ts:53`. Every keystroke then runs
through `useBorrowModal.ts:127-138`:
`const clampedAmount = Math.max(0, Math.min(amount, maxBorrowable))`. In
production (mock off) the user types `500`, the field shows `0`, and
`isDisabled` stays true via `borrowAmount <= 0`
(`hooks/useBorrowModalData.ts:376`). No message is emitted at any point —
grepping `components/NeutronMint/` for "Insufficient|exceeds|not enough" returns
only `DepositModalControls.tsx:154` and `LendModal.tsx:127`; borrow and repay
have **zero** inline validation copy.

There is also no client-side borrow-LTV check with an explanation anywhere. The
only thing that can tell a user "this would breach your LTV" is the on-chain
simulate revert, surfaced as a raw viem string
(`components/NeutronMint/BorrowModalControls.tsx:199-203`).

**Why it matters here.** Borrowing is the product. Right now an unfinished data
source is indistinguishable from a broken UI *because the chosen input idiom is
silent*. That's the design lesson independent of the stub: a silent clamp has no
way to say "I don't know your max," so it says "your max is zero."

**Options.**
- **(a) Never clamp silently** — accept the typed value, disable the CTA, and state the reason ("Max borrow 1,240 CDT — you're 62% of the way to your borrow LTV"). Also makes the LTV ceiling legible instead of invisible.
- **(b) Keep the clamp but annotate it** — snap to max and flash "Clamped to your max borrow," so the number changing under the cursor is explained.
- **(c) Distinguish `max = 0` from `max = unknown`** — when the ceiling can't be computed, disable the input itself with "Borrow capacity unavailable" rather than pretending the answer is zero.

Note the app currently uses **three different idioms for one condition** across
sibling modals — see **P7**.

---

### U8 · A missing price becomes $1 on the way into the borrow modal
**Surface:** S4 → S7 · **State:** partial data

**Today.** `components/NeutronMint/AvailableToBorrow.tsx:129`:

```ts
price: num(assetPrice).toNumber() || (row.symbol === 'CDT' ? 1 : 1), // Default to 1 if no price
```

Both ternary arms are `1`. When the oracle read hasn't resolved or has failed,
the borrow modal opens with the asset priced at exactly one dollar, and every
downstream USD figure and preview in that modal is computed from it.

**Why it matters here.** $1 is not a neutral placeholder in a CDP app — it is a
plausible, peg-shaped number that a user will read as real. Unlike a `0`, it
doesn't look wrong. This is the purest example of a defaulted cell: someone
needed the type to be `number` and the product got a price oracle.

**Options.**
- **(a) Refuse to open** the modal without a price; show "Price unavailable — try again" on the row.
- **(b) Open in a priced-unknown mode** — USD columns render `—`, the amount input still works in token units, the CTA explains what's missing.
- **(c) Keep a fallback but make it impossible to misread** — strike-through or `~$1.00 (estimated)` — weakest option, listed for completeness.

---

### U9 · The liquidate page reads "0 at risk, 0 liquidatable" in green when it can't read at all
**Surface:** S9 · **State:** error / partial

**Today.** `components/Bid/hooks/useCollateralAtRisk.ts:18-19` early-returns
`{ count: 0, totalAtRisk: 0, atRiskCount: 0, totalDebtAtRisk: 0 }` whenever any
input is missing. `components/Bid/Risk.tsx:64` and `:79` then colour those counts
with `atRiskCount > 0 ? warning : success` and `count > 0 ? danger : success` —
so unknown renders as **green**. `components/Bid/MyBid.tsx:93-94` destructures
only `data`, defaults to `[]`, and shows "No active bids" at `:110-116` for both a
failed query and an empty one.

There is a strong reason to think those reads are failing today, though this is
**inferred, not observed**: the write path is real EVM
(`components/Bid/hooks/useBid.ts:36-65` builds `approve` + `submitBid` against
`getContractAddress`), but the read path still runs through
`services/liquidation.ts:16-19`'s `CosmWasmClient`, fed by `appState.rpcUrl`,
and the only supported chain sets `rpcUrl: ''` with the comment
"legacy Cosmos field — dead read paths only" (`config/chains.ts:28-29`).

**Why it matters here.** This surface exists to tell liquidators where the risk
is. Rendering "nothing at risk" in success-green when the queue could not be read
understates protocol risk to precisely the users whose job is to act on it.

**Options.**
- **(a) Make green earn itself** — only apply the safe colour on a resolved, successful query; unknown renders `—` in a neutral tone.
- **(b) Surface the read failure on the card** — a small "queue unavailable" state per card, since a global banner won't fire for a Cosmos-client failure.
- **(c) Decide the half-migrated read path first** — this cell may resolve itself once reads move to `services/chain/liquidation.ts`; worth confirming before designing around it.

---

### U10 · Empty and unknown both get answered with product claims
**Surface:** S4, S10, S14 · **State:** success-but-empty / pending / error

**Today.** Three variants of the same move:
- `components/NeutronMint/AvailableToLend.tsx:64-70` — `maxMbrn > 0 ? formatMbrn(...) : 'Coming Soon'`. An unresolved or failed acquisition read renders a **roadmap statement**.
- `components/Disco/DiscoDepositsEmptyState.tsx:20` — `isLoading ? 'Loading deposits...' : 'No deposits found'`. The app's *best* pending/empty split, and it still asserts "none found" when the truth is "couldn't ask."
- `components/AcquisitionDashboard/AcquisitionDashboard.tsx:40,46` — whole sections vanish (`{windowStats && …}`, `{historyChartData.length > 0 && …}`) when their query returns null or empty. The page renders half-populated with nothing indicating a section is missing.

**Why it matters here.** "Coming Soon" is a promise about your roadmap emitted by
a `|| 0` check. Vanishing sections make a degraded page look like a smaller
page — the user never learns anything is missing, so they never retry.

**Options.**
- **(a) Adopt a three-way vocabulary** — pending / empty / unavailable — and forbid a component from having only two branches. Set it once in a shared `<DataState>` wrapper.
- **(b) Reserve layout for absent sections** — a section that can't load keeps its heading and shows a compact "unavailable, retry" card, so the page shape is stable.
- **(c) Ban product copy in fallback position** — "Coming Soon", "No deposits found", "Full" are claims and should only render from a resolved query.

---

*Also worth deciding, below the top ten:*
- Every success toast links to a **dead Cosmos explorer** — `hooks/useToaster.tsx:65` builds `https://celatone.osmosis.zone/osmosis-1/txs/{hash}` for EVM hashes. The one post-transaction affordance goes nowhere.
- **Simulate error copy is a raw viem string** (`DepositModalControls.tsx:157-160`, `BorrowModalControls.tsx:199-203`, `RepayAmountPanel.tsx:276-280`), falling back to "Transaction simulation failed". No decoding into user language.
- **First-time approve + deposit may be permanently blocked** — `hooks/useSimulate.ts:73-101` simulates *all* calls in the array concurrently against current state, so the `deposit` leg would revert on allowance before the `approve` leg has executed, and `DepositModal.tsx:74` disables the CTA on `simulate.isError`. **Inferred from source; requires a wallet to confirm** — see §5.

---

## 4. Patterns worth deciding once

Twelve local decisions where you could make one global one.

### P1 · Wallet gating — four idioms, two of them on live surfaces simultaneously
1. **Relabel** — `components/TxButton.tsx:29-30` swaps the label to "Connect to Ethereum" and *enables* the button (`isDisabled={false}`).
2. **Silent query disable** — `enabled: … && !!address` with no UI change at all: `useDepositTransaction.ts:77`, `useBorrowTransaction.ts:157`, `useRepayTransaction.ts:77`, `hooks/useBalance.ts:64`, `hooks/useGovernance.ts:41,62,94`, `hooks/useLiquidations.ts:90`, and more.
3. **Early return** — `if (!address) return …`, e.g. `components/ManagedMarkets/ManagedMarketInfo.tsx:148` returns `'—'`.
4. **Explicit copy** — `components/Mint/LockedAccess.tsx:13`, which is **dead code** (`pages/[chain]/mint/index.tsx:15` is commented out).

The live contradiction: `/liquidate` uses idiom 1 (`components/Bid/StabilityPool.tsx` renders `TxButton`), `/mint` uses idiom 2 exclusively. Two primary surfaces, opposite answers to "what does a disconnected user see." **Decide one.**

### P2 · Explaining a disabled button — the mechanism exists and is never used
`TxButton` accepts a `disabledTooltip` (`components/TxButton.tsx:7`) and renders it at `:35`. **No call site anywhere passes it** — across ~30 `TxButton` consumers. So every disabled TxButton in the app is silent, and the connected-but-disabled case gets `label=""`.

The counter-example worth copying is `components/NeutronMint/CollateralRow.tsx:134-151`: at supply cap the button relabels to **"Full"**, recolours to red, sets `cursor: not-allowed`, and enables a tooltip. Label + colour + cursor + tooltip — the best-designed disabled state in the codebase, and the only one that tells you why.

*Also decide:* a disabled Chakra `<Button>` doesn't emit hover events, so a tooltip on one may be unreachable — that needs a live check (§5).

### P3 · Error presentation — writes speak, reads are mute
The app has a genuine, consistent write-path error convention: inline red text under the CTA (`DepositModalControls.tsx:157-160`, `BorrowModalControls.tsx:199-203`, `RepayAmountPanel.tsx:276-280`) plus `components/TxError.tsx` on the legacy surfaces (8 call sites, incl. `components/ConfirmModal/ConfrimDetails.tsx:45` which is what `/liquidate` actually renders). It has **no read-path convention at all**. And there is no safety net: `pages/_app.tsx:36` has `// useErrorBoundary: true,` commented out and no React error boundary exists anywhere in the repo, so an uncaught render throw white-screens into Next's overlay.

Decide: is a failed read a toast, an inline card, a per-widget badge, or a page-level state? Then decide whether an error boundary is the floor.

### P4 · "Unknown" is not a value in this app — give it one
`|| 0` appears 59 times and `?? 0` 9 times in `components/NeutronMint/` alone,
and every one collapses *don't know* into *is zero*. The consequences are U2, U6,
U8, U9. Note there is already a good instinct in the tree to build on:
`components/AcquisitionDashboard/hooks/useAcquisitionDashboardData.ts:96-121`
falls back to `'—'` for most numeric and date fields (though the deposit counts
and the `poolMaxed` / `efficiencyClamped` booleans at `:110,119` still default to
`0` / `false`).

Decide the sentinel (`—`? `?`? a shimmer?), decide whether unknown ever gets a
colour, and decide the *direction* of risk-bearing defaults — U2 is the case
where "unknown" currently means "safe."

### P5 · Mock data is not environment-gated, so it ships
Two different disciplines coexist. `components/NeutronMint/devConfig.ts:9` is
correct — `USE_MOCK_DATA = process.env.NODE_ENV !== 'production'`, with a comment
explaining why. But six services use a hardcoded literal:
`services/disco.ts:24`, `services/acquisition.ts:7`,
`hooks/useMembraneDashboard.ts:16`, `services/manic.ts:51`,
`services/flywheel.ts:46`, `services/systemDiscounts.ts:7`, plus
`services/cdp.ts:675` (`USE_MOCK_VOLATILITY = true`, which feeds the mint page's
Position Overview). All are `= true` with "Change to false when contract is ready."

Beyond the flags, mock is also used as a *fallback* — `services/portMetrics.ts:141,154`
and `components/AcquisitionDashboard/constants.ts:4-23` (a procedurally generated
90-day supply curve rendered with no label, because
`useAcquisitionDashboardData.ts:9` calls `useMBRNSupplyHistory()` with no
arguments and the query is therefore permanently disabled).

Two rules to consider setting: **(1)** mock is env-gated, never a literal; **(2)** mock
never renders unlabelled — if it's on screen, a "Demo data" marker is on screen.

### P6 · Empty-state voice — seven phrasings for "nothing here"
> "Loading available collateral…" (`AvailableCollateral.tsx:61`) · "No collateral deposited. Deposit assets to get started." (`CollateralizedBundle.tsx:90`) · "No position data available" (`LiquidationSimulator.tsx:77`) · "No deposits found" (`DiscoDepositsEmptyState.tsx:20`) · "No assets match this filter" (`LTVDashboard.tsx:435`) · "No active acquisition window" (`PhaseTimelineSection.tsx:132`) · "Coming Soon" (`AvailableToLend.tsx:70`) · `'—'` (`ManagedMarketInfo.tsx:148`)

Different registers — apologetic, technical, promotional, blank. Worth one voice
and one shape: *what's missing · why · what to do next*.

Note the best-written of these is unreachable: `CollateralizedBundle.tsx:83-90`'s
"No collateral deposited. Deposit assets to get started." only renders when
`collateralRows.length === 0`, but `NeutronMint.tsx:200` only mounts the component
when `hasPosition` is true, and `hasPosition` (`:118-124`) requires collateral
`> 0`. The one properly-designed first-run state in the mint page is gated behind
the condition it was written for.

### P7 · Over-max input — three idioms across four sibling modals
- **Deposit** — allow the over-typing, show a message: `useDepositModal.ts:211-217` comments "Allow typing above balance but show error", rendered at `DepositModalControls.tsx:152-156`.
- **Borrow / Repay** — silent clamp, no message: `useBorrowModal.ts:127-138`, `useRepayModal.ts:115-125`.
- **Lend** — disable *and* message: `LendModal.tsx:67,124-128`.
- **Disco / Liquidate** — clamp or nothing: `components/Bid/PlaceBid.tsx:41-42,54-55` clamps silently; `components/Disco/SlotManageTabContent.tsx:146-152` checks only `!amount || <= 0` with no balance check at all.

Four modals rendered in the same visual family, four answers. One decision covers all of them.

### P8 · Data freshness has no expression in the UI
`pages/_app.tsx:37-41` sets `staleTime: 300000` (5 min) with
`refetchOnWindowFocus`, `refetchOnMount` and `refetchOnReconnect` all `false`.
So a route can serve five-minute-old prices and LTVs and will not refresh when
the user returns to the tab, remounts the page, or reconnects to the network —
only an explicit `invalidateQueries` after a write moves it. Nothing anywhere
renders `isFetching`, `isRefetching`, or a "last updated" timestamp (grepped
across all 14 surfaces: zero hits).

For a lending UI where a stale price is a liquidation, the questions are: what is
the acceptable age of a number on each surface, does the user get to see that
age, and is there a manual refresh?

---

## 5. What only a live browser can tell you

These cells could not be settled from source. Each needs a driven session, and
two of them need a wallet — which `sensors.json:safety.walletPolicy` forbids and
which has no mock connector, so they are **coverage gaps**, not to-dos.

1. **Whether the seeded-chain happy path actually resolves.** Everything in §3 about S4/S5 assumes the query either resolves or doesn't. Whether `Available Collateral` populates against a freshly seeded anvil — and how long it takes — needs the `typical` fixture. Mind the 8545/8546 port trap (`sensors.json:state.portMismatchWarning`).
2. **The approve+deposit simulate hypothesis.** Whether a first-time depositor is actually blocked by `useSimulate.ts:73-101` simulating the `deposit` leg pre-allowance. Requires a funded connected wallet — **not agent-drivable**.
3. **Whether the reverted-tx toast really reads as success.** `useToaster.tsx:48-60` sets `colorScheme: 'primary'` on a dark container, so the green/red distinction may be weaker or absent in practice. U1's severity depends on how it looks, and that needs eyes plus a real revert.
4. **Whether any disabled-button tooltip is reachable.** Chakra disabled buttons don't emit pointer events; `CollateralRow.tsx:134-151`'s tooltip and `TxButton.tsx:35` may never fire on desktop and certainly not on touch.
5. **Dev-vs-prod divergence on the mint page.** `devConfig.ts:9` masks the zero-stubs of U2 and U7 under `pnpm dev`. Both readings need capturing — the mock one shows the intended design, the prod one shows what a user gets.
6. **RPC banner timing, both directions.** How long from node death to banner (bounded by 60s, `RPCStatus.tsx:20`) and — unmeasured — how long from node recovery to the banner clearing.
7. **Layout behaviour when the banner appears.** It's an inline `<Alert>` inside `<main>` (`Layout.tsx:92`), so it pushes content down mid-session; that's a CLS question source can't answer.
8. **What wrong-chain actually looks like end to end.** Whether MetaMask or the RainbowKit modal surfaces anything the app doesn't, and whether the resulting page is merely empty or actively wrong.
9. **The `hasPosition` false→true flash.** Four components mount at once when it flips (`NeutronMint.tsx:169,181,200,206`); whether that reads as a load or a jump is a live-only judgement.
10. **Whether the liquidate reads genuinely fail today** (U9's inference). One page load with the network panel open settles it.

---

## 6. Three things already designed — worth copying, not rewriting

Stated because a matrix this red can read as "nothing is decided," which isn't true.

- **`components/NeutronMint/CollateralRow.tsx:134-151`** — the supply-cap disabled state: label becomes "Full", colour and cursor change, tooltip explains. This is the template for P2.
- **`components/ConfirmModal/LoadingContent.tsx:17,29`** — the tx-pending state on `/liquidate` distinguishes "Approve transaction on {wallet}" from "Broadcasting transaction" via `tx.isApproved`. The mint modals collapse both into one Chakra spinner; this is the better pattern and it already exists.
- **`components/NeutronMint/PositionOverview.tsx:245-260`** — the only surface that renders real skeletons for its own `isLoading` while returning `null` when there's genuinely nothing. Add a third branch for error and it's the model for P3.
