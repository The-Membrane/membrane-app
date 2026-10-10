# UI sensory findings — first driven session (2026-08-15)

Environment: **NO CHAIN.** No RPC on 127.0.0.1:8545 or :8546; every in-browser
`eth_call` returned ERR_CONNECTION_REFUSED. Server ran NODE_ENV=development, so
`USE_MOCK_DATA` and `USE_MOCK_COLLATERAL_DATA` were both on — every number on
`/ethereum/mint` is fabricated. This is the manifest's ERROR fixture, and it
governs every attribution below.

12 routes reached, viewports 375 / 768 / 1280, light + dark.

---

## Sensor faults caught by the control probe (read this first)

The control probe (SKILL.md §7) paid for itself three times. Without it, S3
would have shipped as a false HIGH.

- **S1 — the browser pane never paints unattended.** `visibilityState: hidden`,
  rAF never fires, and a deliberately forced 120ms main-thread burn produced
  **zero `longtask` entries**. Therefore **CLS / FCP / LCP / TBT are
  unmeasurable in this environment** — every such counter read 0. No finding
  below rests on them. Reporting "CLS = 0" would have been a sensor artifact
  reported as a clean bill of health. Geometry is valid only after a forced
  screenshot.
- **S2 — `read_page` returned "(empty page)"** against a document with 211
  nodes. Worked around with `get_page_text` + JS digests; no axe-style a11y
  audit was possible.
- **S3 — near-miss false finding.** `/terms` read as permanently stuck on
  "Loading terms…", spinner live, **zero `/TOS.md` network requests**, while
  `curl` confirmed 200 / 3570 bytes. Looked like a broken legal page. After
  forcing a paint: 11 headings, spinner 0, fully resolved. S1 was deferring the
  `useEffect`. **`/terms` is healthy** — the instrument was the defect.

---

## Findings

### F1 — Every navigation costs a fixed ~800ms with no feedback
**severity: high · attributed: code · VERIFIED**

Measured: liquidate 1001ms, disco 998ms, mint 1047ms, about 950ms,
membrane-dashboard 998ms — **flat across static and data-heavy routes**, so it
is not fetching. A loading indicator was absent on 4 of 5.

Cause is a design decision, not a defect: [components/PageTransition.tsx:13-22]
uses `AnimatePresence mode="wait"` with `duration: 0.4`, which serializes a
0.4s fade-out *then* a 0.4s fade-in. The old page stays on screen the whole
time, so the app feels unresponsive to the click.

```diff
- <AnimatePresence mode="wait" initial={true}>   // exit 0.4s ─► then ─► enter 0.4s ≈ 800ms
+ <AnimatePresence>                              // crossfade (overlap), or drop to ~0.15s
    transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
```

This is a **design-stage** finding: the transition is intentional, its cost is
probably not. Worth deciding deliberately.

### F2 — "Max LTV" label renders the *borrow* LTV
**severity: high · attributed: code · VERIFIED · production path**

[components/NeutronMint/CollateralRow.tsx:103] renders
`Max LTV: {num(row.maxBorrowLTV).times(100).toFixed(0)}%` — the borrow LTV
under a "Max LTV" label. The correct value is populated one line away and
discarded: [hooks/useCollateralRows.ts:78] sets `maxLTV: basketAsset.maxLTV`
alongside `maxBorrowLTV` at :79.

Observed 78/75/73/87% displayed where the real max LTVs are 82/80/78/90%.
Shared by both the mock and real-basket branches, so it is **not** a dev-only
artifact.

Why this is not polish: in a lending UI "Max LTV" reads as the *liquidation
threshold*. Showing borrow LTV understates a user's distance to liquidation by
4-5 points per asset. This is a wrong number with a safety consequence, and the
fix is a one-identifier change.

### F3 — Mint shows "No collateral deposited" above a $200 debt
**severity: high · attributed: code · dev-only**

One panel shows zero collateral backing $200 of debt. `DebtCard` is fed the mock
override ([NeutronMint.tsx:90-93, 207-214]) while its sibling
[CollateralizedBundle.tsx:17-27] never imports the mock and calls live hooks;
those fail, the guard at :31 empties the rows, and the empty state at :83-94
renders. Half the page is mocked and half is live.

Also: `mockBorrowData.ts` is still Cosmos-era while `mockCollateralData.ts` is
EVM-migrated, so the manifest's `ui.mockCheck` digest reports `mock: false` on a
fully-mocked page — **that digest is stale and should not be trusted.**

### F4 — 375px silently clips content instead of scrolling
**severity: high · attributed: code**

17 content cards render 376px wide against a 375px viewport (right edge 392px =
**17px overhang each**); "Deposit assets to get started" and the MANAGE button
are cut off. Because `body { overflow-x: hidden }`, `scrollWidth` still reports
375 — there is no scrollbar, so the content **clips rather than scrolls and
evades the usual sideways-scroll check.** Persists at 768px (6 elements, ≤9px).
At 1280px the overhang is decorative SVG only — benign, not filed.

### F5 — A dead RPC shows confident numbers for ~60s
**severity: medium · attributed: code**

membrane-dashboard rendered "91,486 CDT gross / 4.89% avg rate / 55.9% save
rate" while **100% of eth_calls were failing** and the RPC banner never
appeared. [RPCStatus.tsx:20-21] polls at 60s with `retry: 1` and renders only on
`isError`. A user can read revenue and rates off a dashboard whose every source
is down.

Same shape as the `AvailableCollateral` finding and the contract-side D4: an
unknown state rendered as a known one.

### F6 — Skeletons never appear
**severity: medium · attributed: code**

`.chakra-skeleton` and `.chakra-spinner` counted **0 on every sample of every
route** (~1,200 samples), despite the manifest documenting 4 Skeleton sites.
`ssr: false` dashboards first-paint fully blank.

### F7 — Portfolio shows progress for a disconnected user
**severity: medium · attributed: code**

"8 Total points", "LVL 1", a ~30%-filled bar, and a counter ticking at
0.000179/sec — with **no in-page connect prompt**. Non-zero points for a null
address is not an empty state.

### F8 — Two live nav links 404
**severity: medium · attributed: code**

`/borrow` → 307 → `/ethereum/borrow` → 404, linked from the active home page
([Home/NeuroGuardParts/VaultEntry.tsx:59]) and twice from [SideNav.tsx:46,58].
`/manic` → `/ethereum/manic` → 404 ([StatusTab.tsx:256]).

### F9-F12 — lower severity
- **F9** revenue chart draws axes + legend over an empty plot with no "no data"
  state (low/med).
- **F10** LTV dashboard ASSET column shows raw hex (`0xC02aaA…`) instead of
  symbols — and they are **mainnet addresses on a 31337 chain** (medium).
- **F11** Ditto hologram overlaps the revenue chart's axis labels at 1280×800
  (global overlay, [Layout.tsx:97]) (low).
- **F12** route announcer says "Membrane" for every route rather than the page
  title (a11y, low).

### F13 — Light theme not implemented — NOT a bug
**attributed: expectation.** The browser honored `prefers-color-scheme: light`;
the app stayed `rgb(9,9,10)` / Chakra `dark`. The manifest records light theme as
not implemented, so this is a correct observation of an intentional gap, filed
as an expectation correction rather than a defect.

---

## Smoothness numbers actually measured

Nav latency 950–1047ms across 5 routes (~800ms fixed) · loading indicator on 1/5
· skeletons/spinners 0/0 · ltv-dashboard time-to-content 375ms warm · Disco
label→value gap 0ms warm, main height stable 1877px (0px jump) · overflow
17×17px @375, 6×9px @768 · home dev weight ~14.3MB / 14 resources, `_app.js`
3049ms (dev-unminified — **re-measure in prod before treating as a finding**).

Cold-load transient: Disco first-paints units without numbers ("Total TVL /
MBRN", "Active Slots / 0"). Warm-nav measurement was 0ms so it is not filed, but
it is the shape a slow-network user sees.

**Not measured, and why:** CLS, LCP, FCP, TBT, long-task jank — all unmeasurable
per sensor fault S1.

---

## What blocked sensing

1. **No rendering browser** → all paint-timing metrics unsensed. Playwright is
   configured but **has no browsers installed**; `pnpm exec playwright install
   chromium` would unblock this (not run — large download, unapproved).
2. `read_page` a11y tree unusable → no axe-style audit.
3. **No chain.** F2/F4/F8/F10/F12 are chain-independent; F3/F5/F6/F9 want a
   re-run against a seeded anvil.
4. Wallet flows not drivable (no mock connector); sensed only to the connect
   boundary.
5. The home page sits behind an "Initiate Scan to Accept the Terms" consent
   gate. Accepting terms requires explicit user permission, so it was not
   clicked — **content behind that gate is unsensed.**

## Ratchet targets (deferred — see below)

nav-latency assertion (F1) · 375px overflow assertion (F4) · `maxLTV` binding
unit test (F2) · broken-link crawl over SideNav hrefs (F8) · RPC-down test via
Playwright `page.route` (F5).

**Deliberately not ratcheted yet.** The app is mid-design; pinning Playwright
assertions to screens that are about to change would make the test suite a
reason not to change the design. Sensory observation during design; deterministic
tests once the shape settles. F2 is the exception — it is a wrong number, not a
layout choice, and its unit test is design-independent.
