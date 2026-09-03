# Badass User Audit — membrane-app (`evm-migration`)

**Date:** 2026-09-02
**Doctrine:** Kathy Sierra, *Badass: Making Users Awesome*, as codified in
[`docs/BADASS_RULESET.md`](BADASS_RULESET.md), plus four rules added by this audit's brief:
standalone-tool gating (rule 8 "valuable before commitment"), share artifacts must be about the
user's result, redemptions must be legibly debt-only without prose, fingerprint scanner off the
entry path.
**Method:** six parallel static sweeps of every routed surface (entry/nav, carry tools, borrower
surfaces, retrospective/share, copy/notifications, redemption/peripheral). No runtime verification;
all claims cite file:line. Severity: **P0** teaches the user something wrong or softens failure;
**P1** tells instead of teaches, or gates a standalone tool behind a position/discoverability wall;
**P2** overhead with no capability gain.

---

## The one-paragraph verdict

The doctrine is written down and the best surfaces in this app already obey it — Evidence's
commit-before-reveal ForecastGate, Builder's survival-graded gauntlet, Carry/Simulator's provenance
stamps, and the Position prototype's Encounters/Calibration/DittoRecap are genuinely
badass-compliant. The defects are almost all **wiring and placement, not philosophy**: the
retrospective/attribution layer lives only in a dead fixture-driven prototype while the live
borrower path is silent; the best standalone tool is orphaned from the nav; the share layer grades
wealth instead of process in direct violation of the repo's own ruleset §11; one error branch
literally prints "Success"; and one dashboard renders fabricated risk countdowns with no mock
stamp. The fix program is therefore mostly: move what already exists to where the rules say it
must live, stamp or delete what fabricates accuracy, and strip the P&L grading.

---

## Answers to the four audit questions

**1. Fastest path from landing to first real capability.**
`/` 307-redirects to `/ethereum`, which renders Evidence. **1 click, 0 inputs, 0 navigation**: the
ForecastGate asks the user to commit to a band ("how much debt does a liquidation actually
close?") before revealing the cohort answer — a genuine calibration rep on the entry page
(`components/Evidence/ForecastGate.tsx:50-159`). The first *personalized* capability (a graded
sizing decision) is 2 clicks + 1 drag away via nav → Builder → drag venue → "Run the gauntlet".
The tool that would let a user price *their own* BTC/LTV with no wallet — the `/landing`
Hero/Counterfactual calculator — is unreachable: absent from `HorizontalNav.tsx` and from
`pages/sitemap.xml.tsx` (P1-1 below).

**2. Tools requiring a position/wallet that could work without one.**
Almost none — the demo-mode pattern (`components/demo/DemoAwareCta.tsx:38-53`) correctly gates
only the final signing action. The failures are inverted: standalone tools that exist but can't be
*found* (`/landing`, `/boost`), and the rule-8 tool that's missing outright — nowhere can a trader
type a contemplated size and see it checked against venue exit capacity, even though the capacity
data is already rendered in two places (`Carry/RedemptionHistory.tsx`, `EarnPage/ExitLiquidity.tsx`).

**3. Copy explaining what a chart/number could render.**
Concentrated in one cluster: the Ditto/tutorial layer (`DittoSpeechBox/tabs/LearnTab.tsx:19-138`,
`Disco/discoTutorialConfig.ts:6-79`, `config/dittoMessages.ts:135-160`) plus two generic-bucket
tooltips on the live mint page (`NeutronMint/PositionOverview.tsx:169,274`). Meanwhile a
numeric fact engine that solves exactly this (`contracts/manicContract.ts:167` et al.) is wired
for ambient insights but not for the post-transaction moment or the FAQ.

**4. Anywhere the user is asked to admire the product rather than their own result.**
Yes: the About page — first item in the primary nav — is pure product-lore ("neural nexus",
"military-grade encryption", a fabricated "99.7%" status; `pages/[chain]/about/index.tsx:18-25,166-182,243`).
The Portfolio share tweet is literally "Check out my Membrane portfolio! 🔥"
(`hooks/useShareableCard.ts:97`), and every share card carries a Membrane watermark under a modal
titled "Share Achievement" (`ShareableCard.tsx:104-134`, `ShareModal.tsx:236`).

---

## P0 — teaches wrong or softens failure

| # | Surface | What the user can do better after seeing it | Rule violated | Fix |
|---|---|---|---|---|
| P0-1 | `helpers/parseError.ts:60` — `Unexpected end of JSON input` → message **"Success despite error"** | Nothing; an error branch prints "Success" | 5 (softens failure) | Honest copy: response was cut off, check the explorer for the real result |
| P0-2 | `components/LTVDashboard/LTVDashboard.tsx:311-327` — "Liquidation LTV Updates" table incl. "Pending" values and "Update In" countdowns sourced entirely from `mockHistoricalLTVData`, no mock stamp anywhere on the page | Negative — a borrower could time real top-ups around fabricated countdowns | Never fabricate accuracy | Stamp the whole table as illustrative until wired to real pending-LTV state |
| P0-3 | `components/NeutronMint/CollateralRow.tsx:6,175-186` — mock `Target LTV` fallback blended with real `maxLTV`/`price` in the live mint tree, visually identical | Same trust failure inside the live borrower path | Never fabricate accuracy | Remove the mock fallback or stamp it |
| P0-4 | `pages/[chain]/transmuter.tsx:9-13` — page titled/SEO'd "Transmuter — Swap Stablecoins for CDT" renders a Lockdrop deposit UI (`acquisition/AcquisitionVisualizer.tsx:147,177`); no swap, no redeem, and zero redemption legibility anywhere in the slice | Nothing — user can't even tell what page they're on | 1, 5 + redemption-legibility constraint | Retitle page + SEO to what it does (Lockdrop) until the real transmute UI lands here |
| P0-5 | `hooks/useContributionPercentage.ts:59-78` + `ShareableCard/CardTypes/ContributionCard.tsx` — "Stabilizer→Prime Engineer" tier = 80% wealth share + 20% revenue share, with "you stand among the elite" copy | Nothing — certifies wallet size as skill | 7 (and `BADASS_RULESET.md:228` prohibits this verbatim) | Strip the tier ladder + elite copy; render the shares as plain facts |
| P0-6 | `ShareableCard/CardTypes/BoostCard.tsx:29-45` + `BoostLevelBar.tsx:36-45` — milestone-badged "boost level" that is 1:1 MBRN-locked, a capital dial | Nothing — badges a deposit size | 7 | De-badge; plain balance display |
| P0-7 | Share layer framing: `ShareModal.tsx:236` "Share Achievement", tweet texts `useShareableCard.ts:93-97` ("I've earned $X! 🚀", "Check out my Membrane portfolio! 🔥") | Nothing repeatable — celebrates P&L or the product, not a decision | 7 + share-artifact rule | Reword to facts about the user's result; kill "Achievement" |
| P0-8 | Transaction lifecycle app-wide: `hooks/useTransaction.ts:67`, `hooks/useExecute.ts:29` — every deposit/borrow/repay ends in a numberless "Transaction Successful" toast; `config/dittoMessages.ts:135-160` canned acknowledgements ("Loop complete! Your position has been optimized") live via `AcquisitionClaimCard.tsx:56` | Nothing — the single richest teaching moment (right after the user acts) renders zero consequence | 1, 3 | Render the position delta the just-invalidated queries already fetch; delete the canned prose |
| P0-9 | `components/DittoSpeechBox/tabs/LearnTab.tsx:19-138` — live FAQ: paragraph explanations of LTV, liquidation, boost, looping | Reads definitions instead of seeing own numbers | 1 | Replace each answer with the user's own rendered number/chart (looping tradeoff already exists numerically at `contracts/manicContract.ts:167`) |
| P0-10 | Live borrower path is **silent on rescue and failure**: no surface in `components/NeutronMint/*` reports a partial liquidation, cure-window save, or price-window effect on the user's own position; the correct pattern exists only in dead fixtures (`Position/fixtures.ts:126-141`) | A liquidated/rescued borrower learns nothing — the exact "silent rescue teaches carelessness" defect | 3, 5 (by absence) | Port the Encounters/attribution pattern to real position/event data; until then this is the top structural gap |

## P1 — tells instead of teaches, or gates/orphans a standalone tool

| # | Surface | Problem | Rule | Fix |
|---|---|---|---|---|
| P1-1 | `pages/[chain]/landing.tsx` (Hero/Counterfactual/HonestPart personalized BTC/LTV calculator) | The best rule-8 tool in the app is orphaned — not in `HorizontalNav.tsx:22-51`, not in `sitemap.xml.tsx:15-21` despite its own comment claiming "the one indexable page" | 8 | Add to nav + sitemap |
| P1-2 | `HorizontalNav.tsx:43-49` + `CyberpunkLevelsData.ts:13-69` | Transmuter/Stake/Manic/Maze-Runners/Bridge only discoverable through the fingerprint-scan ritual → `/levels`; the ritual carries zero decision content | 9 | Nav-link `/levels` (or the routes) directly; ritual becomes optional flavor. Scanner itself is compliant: off the entry path |
| P1-3 | `pages/[chain]/about/index.tsx` first in `navItems` (`HorizontalNav.tsx:23`) | Product-lore page ahead of Evidence; fabricated stats ("99.7%", "Neural sync nominal") | 1 + admire-product | Demote in nav; strip fake stats |
| P1-4 | `components/Carry/Collateral.tsx:50` | Unmeasured collaterals (sUSDS/syrupUSDC/scrvUSD, `fixtures.ts:33-39`) render p999/worst at the same 2-decimal precision as measured ETH/BTC; provenance stamp only appears after Advanced→select | Never fabricate accuracy | Per-card unverified badge in the browse view |
| P1-5 | `components/EarnPage/fixtures.ts:38` vs `:92-95` | "COOLING — lands Aug 22, 04:10 UTC" minute-precision ETA the code itself calls reconstructed-and-possibly-wrong | Never fabricate accuracy | Band the ETA ("~Aug 22"); caveat next to the number |
| P1-6 | Size-aware exit check missing (`Carry/RedemptionHistory.tsx`, `EarnPage/ExitLiquidity.tsx` have the data; `Ladder.tsx` is ratio-only) | Trader can't test "does my $2M land instant/cooling/stranded" | 8 | Wire the existing size input to the existing band data |
| P1-7 | `NeutronMint` has no retrospective at all; `PortPage.tsx` (Portfolio) is 100% prospective ("Keep earning points towards HIGHER yield", `PortPage.tsx:190`) | Rule 2 violated by omission on both live surfaces | 2, 4 | Lead Portfolio with a did-vs-could-have module once real history is wired (see P0-10) |
| P1-8 | No borrower-facing liquidation history: `/liquidate` renders the bidder UI (`pages/[chain]/liquidate/index.tsx` → `components/Bid`) | The person who got liquidated has no page to review what happened | 3, 5 | Borrower "what happened" view keyed to their own draw % |
| P1-9 | `ShareableCard/CardTypes/PointsCard.tsx:38-45,155-159` — "Champion / defend your legacy" rank ladder; points scale with $ moved (`PointsProgressFullCard.tsx:79-81`) | Competitive ranking on a wallet-size-scaling metric (formula server-side, unverified) | 7 (probable) | Verify formula; de-emphasize rank framing |
| P1-10 | `components/Disco/discoTutorialConfig.ts:6-79` — 6 prose tutorial steps + 7 prose FAQs | Tells disco mechanics next to a live graphic that could show them | 1 | Point-at-and-interact steps; kill the FAQ wall |
| P1-11 | `components/Disco/EpochRevenueCard.tsx:166-186` — "Estimated APR" whose own tooltip admits "APR is a faulty stat" | Shows a number it declares wrong instead of the right number | 1 | Compute the lock-boosted figure; drop the apology tooltip |
| P1-12 | `pages/lockdrop.tsx` → `Lockdrop/Info.tsx:16-19` — dense prose for a concluded 7-day event, no "closed" signal; deposit pane commented out (`Lockdrop.tsx:13`) | Live page, dead event, ambiguous state | 1, 5 | Badge as historical/closed |
| P1-13 | `pages/[chain]/boost.tsx` — fully built, orphaned from every nav path | Built value behind no door | 9/8 | Add a nav/levels entry |
| P1-14 | `helpers/parseError.ts:42` — "Depositor safety check failed, operational error." | Vague; nothing actionable | 5 | Say what to change |

## P2 — overhead, dead code, minor tells

| # | Surface | Problem |
|---|---|---|
| P2-1 | `components/SideNav.tsx`, `components/Header.tsx` | Dead (imported nowhere) |
| P2-2 | `CyberpunkHome.tsx:287-661,663-924` LobbyView/AboutView + `handleReceptionist` | Dead internal views, unreachable |
| P2-3 | `pages/[chain]/about/index.tsx:264-299` | BACK and EXPLORE LEVELS both push `/levels` |
| P2-4 | `pages/management.tsx:5-11` | Redirect to a route that doesn't exist (404) |
| P2-5 | `pages/bid.tsx` | Redirect to `/{chain}/bid` which doesn't exist |
| P2-6 | `CyberpunkLevelsData.ts` Bridge entry | Dead link — page doesn't exist |
| P2-7 | `components/Stake/Staking copy.tsx` | Stray duplicate file |
| P2-8 | `components/Carry/Timeline.tsx` | Generic breach→cure diagram not wired to the user's selected rung (`rungMetrics` exists in `Carry/utils.ts:34-43`) |
| P2-9 | `NeutronMint/PositionOverview.tsx:169,234,274` | Generic bucket-definition tooltips where the user's own `worstCaseDrop` (`:291-294`) could speak |
| P2-10 | `Borrow/CureTimeline.tsx` | Self-described "reading matter"; could animate the user's slider LTV instead |
| P2-11 | `config/dittoMessages.ts:46-53,67,96` | Content-free filler ("Click if ur cool 😎", "Nice!") |
| P2-12 | `DittoSpeechBox/hooks/useContextualHelp.ts` | Dead duplicate of the FAQ prose |
| P2-13 | `pages/[chain]/headquarters/index.tsx` | Near-empty decorative page |
| P2-14 | `/control-room`, `/nft`, acquisition-dashboard/sim | Orphaned (acquisition ones intentionally, per `HorizontalNav.tsx:54` comment) |
| P2-15 | `ShareableCard/CardTypes/PortfolioCard.tsx:159-169` | "Building wealth through decentralized finance" tagline |
| P2-16 | `ManagedMarkets/*` tooltips (`ManagedMarketInfo.tsx:90,213`), debug `console.log`s | Legacy Cosmos-era module; lowest priority |
| P2-17 | `pages/[chain]/landing.tsx:6-10` stale comment; `DittoToast.tsx:100` re-export-only note | Doc drift |

## What already complies (don't break these)

- **Evidence + ForecastGate** (`components/Evidence/`) — retrospective, commit-before-reveal, shows the 105 accounts where Membrane did worse. The strongest surface; entry page.
- **Builder** (`components/Builder/Builder.tsx:78-79`) — "a build that earns more and dies is not a better build": survival-graded, wallet-free.
- **Carry + Simulator** provenance discipline (`Simulator/ComparisonPanel.tsx:228-256`, `Stamp.tsx`) — uncollapsible read-this-first boxes, on-chain/measured/modelled color coding.
- **Demo-mode CTA pattern** (`demo/DemoAwareCta.tsx:38-53`) — gates only signing, replays intent post-connect.
- **Position prototype content** (`Position/fixtures.ts:126-141`, `DittoRecap.tsx:88`) — the correct retrospective/attribution/failure language, awaiting real data.
- **Numeric fact engine** (`contracts/manicContract.ts`, `discoContract.ts`, `transmuterContract.ts`, `portfolioContract.ts`) — the render-not-tell machinery, wired for ambient insights.
- **Caching discipline** — react-query staleTime 30s–5min everywhere checked; no raw polling loops (`hooks/useTransmuterData.ts`, `hooks/useAcquisition.ts`, `Bid/hooks/useBid.ts:36`).

---

# Phase 2 — Fix log

Appended per fix: what changed, which rule it serves, what the user can now do.

### P0-1 + P1-14 — honest error copy (`helpers/parseError.ts`)
Rule 5. "Success despite error" (a JSON-parse failure branch) now says the outcome is unknown and
points at the explorer; "rate assurance failed" now says what the protocol did for the user
(rejected rather than mispriced) and what to try. **The user can now tell an unknown outcome from
a success, and knows what to change after a rate-assurance revert.**

### P0-2 — LTV Dashboard mock stamp (`components/LTVDashboard/LTVDashboard.tsx`)
Never-fabricate rule. The "Liquidation LTV Updates" table (100% `mockHistoricalLTVData`, including
"Update In" countdowns) now carries a warning-colored `mock — not live` stamp beside the H1 and a
subtitle telling the user not to time deposits off it. **The user can no longer mistake fabricated
pending-LTV countdowns for live risk data.**

### P0-3 — mock branch deleted from the live mint tree (`components/NeutronMint/CollateralRow.tsx`)
Never-fabricate rule. The expanded collateral row's "Target LTV" mock fallback and the all-mock
LTV history chart were removed; the row now renders only chain values (`maxLTV`, `maxBorrowLTV`,
oracle price). **Everything the borrower sees in the live mint tree is now real.**

### P0-4 — Transmuter page identity (`pages/[chain]/transmuter.tsx`, `acquisition/AcquisitionVisualizer.tsx`)
Rules 1/5 + redemption legibility. The page SEO promised "Swap Stablecoins for CDT" over a
Lockdrop deposit UI with no swap and no redemption surface. Retitled page + H1 to "Transmuter
Lockdrop" and rewrote the SEO to describe what the page does. **The user now knows what page they
are on.** (The real transmute/redemption UI, with its debt-only rendering, remains to be built —
see Blocked below.)

### P0-5 — contribution tier ladder removed (`ShareableCard/CardTypes/ContributionCard.tsx`, `Portfolio/PortPage/ContributionMeter.tsx`)
Rule 7 (and `BADASS_RULESET.md` §11 verbatim). The Stabilizer→Prime Engineer tiers — 80% wealth
share + 20% revenue share — and the "you stand among the elite" copy are gone from both the share
card and the Portfolio meter. Both now render two plain facts: share of system TVL, share of
revenue. **What the user shares is now a fact about their account, not a badge certifying wallet
size as skill.**

### P0-6 — boost de-badged (`ShareableCard/CardTypes/BoostCard.tsx`)
Rule 7. Dead Starter→Legendary tier code deleted; "Maximum Boost Achieved!" now states the cap as
a pricing fact. The next-milestone box stays — boost rate is a real protocol parameter, so the
target is decision-relevant, not a grade.

### P0-7 — share layer reframed (`hooks/useShareableCard.ts`, `ShareModal.tsx`, `PortfolioCard.tsx`)
Rule 7 + share-artifact rule. Tweet texts are now facts about the user's own account (no 🚀/🏆,
no "I'm a {tier}", and the Portfolio tweet no longer plugs Membrane); the modal is "Share Your
Record", not "Share Achievement"; the tagline is "My positions, on the record" instead of
"Building wealth through decentralized finance".

### P0-8 — post-transaction rendered consequence (`hooks/useTransaction.ts`, `useSimulateAndBroadcast.ts`, NeutronMint modals, `config/dittoMessages.ts`, `TxConfirmationSection.tsx`)
Rules 1/3/5. Three changes:
1. `useTransaction`/`useSimulateAndBroadcast` accept an optional `successMessage`; the three live
   borrower flows pass their previewed delta: borrow/repay toast **"Debt $X → $Y"** (real vault
   summary debt ± the user's own amount), deposit toast **"+N SYM collateral · debt unchanged"**.
   LTV deltas were deliberately NOT wired: `collateralValue` is an honest-empty stub until the
   Collateral service lands, and rendering an LTV from it would teach a fabricated number.
2. All celebratory tx acknowledgements ("Loop complete! Your position has been optimized") replaced
   with neutral action-landed statements; the rendered Points delta remains the teach moment.
3. Bug found during the fix: the acknowledgement line rendered under the **failure** header too
   ("Deposit confirmed!" under "Transaction Failed") — now gated on success (rule 5).
**After acting, the user reads what their action did to their debt, not applause.**

### P1-1 — the orphaned calculator is now reachable (`HorizontalNav.tsx`, `pages/sitemap.xml.tsx`)
Rule 8. `/landing` (personal BTC/LTV carry calculator, wallet-free) added to the top-level nav as
"Calculator" and to the sitemap. **A trader can now find the strongest no-commitment decision tool
without typing a URL.**

### P1-2 — direct door to Levels (`HorizontalNav.tsx`)
Rule 9. "Levels" added to the menu, so Transmuter/Manic/Stake/Maze Runners are discoverable
without completing the fingerprint-scan ritual. The ritual survives as optional flavor — and stays
off the entry path, as required.

### P1-3 — About demoted to last nav slot (`HorizontalNav.tsx`)
Rule 1 / admire-the-product. The lore page no longer leads the nav; Evidence/Simulator/Calculator
do. Page content untouched (its fake stats are a follow-up).

### P1-4 — unverified collateral tails stamped in browse view (`components/Carry/Collateral.tsx`)
Never-fabricate rule. sUSDS/syrupUSDC/scrvUSD (no `measured` provenance; sourced from a file that
does not exist on disk) now render at reduced precision, without the sample count, with an inline
warning-colored "unverified" on the card itself — not only in the post-selection ladder stamp.
**The trader can now see which tail numbers to trust while comparing cards, not after choosing.**

### P1-5 — reconstructed ETA banded (`components/EarnPage/fixtures.ts`)
Never-fabricate rule. "COOLING — lands Aug 22, 04:10 UTC" → "lands ~Aug 22 (reconstructed ETA)",
consistent with the file's own stamp admitting the ETA can be silently wrong.

### P1-6 — size-aware exit check (`components/EarnPage/ExitLiquidity.tsx`, `utils.ts`)
Rule 8 — the audit's biggest capability gap. New input on the exit-liquidity card: type a
contemplated size and see it split across the bands in fill order — "$1.5M exits now · $0.5M lands
~Aug 22 · $0.3M stranded until an operator cranks" — with a proportional bar, against the same
(mock-stamped) capacity data the card already renders. **The trader can now test whether THEIR
size survives the exit, which is the depth-aware-sizing rung of the ladder.**

### P1-13 — /boost gets a door (`HorizontalNav.tsx`)
Rule 9. The fully-built boost page added to the menu.

### P2-15 — portfolio share tagline (`PortfolioCard.tsx`) — folded into P0-7.

### Re-graded during Phase 2
- **P0-9 (LearnTab prose FAQ) → P1, blocked.** By the severity rubric, tells-not-teaches is P1.
  More importantly the fix is data-blocked: the disco/manic/transmuter numbers behind any rendered
  replacement are mock-flagged services today (`services/disco.ts:23 USE_MOCK_DATA = true`,
  `services/manic.ts:51`), and `useUserPositions` returns `[]` off `/mint`/`/portfolio` by design
  (`hooks/useCDP.ts:151`). Replacing prose with fake "your numbers" would violate never-fabricate.
  Fix when the mock flags flip; the page-contract interpolation engine
  (`useDittoMessageEngine.ts`) is the machinery to reuse.
- **P2-11 (filler Ditto messages)** — moot: the whole `timedMessages` array is `@deprecated` with
  zero consumers (verified by grep); the filler never renders.

## Owner rulings (2026-09-02) and the second pass

The five blocked items were ruled on; this pass implemented the rulings:

### #1 + #3 (merged) — "Your record" leads the Portfolio (`PortPage/YourRecord.tsx`, `hooks/usePositionEvents.ts`)
Rules 2/3/5/6 + redemption legibility. The retrospective/event module the borrower path was
missing now leads the Portfolio page ("01 / Your record"), with three honest states:
- **No wallet (demo):** the fixture encounters render under the "Demo — not yours" banner —
  perceptual exposure, clearly not yours.
- **Wallet, no events:** "your record starts with your first position", pointing at the cohort
  archive and the gauntlet — the practice surfaces. Nothing fabricated.
- **Wallet, events:** real events via `usePositionEvents`, whose typed contract encodes the
  attribution payload (headroom low-water, why-sizing-sufficed) and the redemption invariant:
  redemption events render **"debt −$X · collateral untouched −$0"** as numbers, never prose.
  The hook returns `[]` until the DOPAMINE_LOOP_ROADMAP §2 event pipeline lands — it must never
  synthesize events for a connected wallet.
Owner's question, answered in-design: retrospective is NOT necessary pre-position — Sierra's
rule 2 governs users *with* history; pre-position learning is perceptual exposure + practice,
which the entry flow (ForecastGate, Builder) already leads with. So pre-position the module
shows the demo exemplar / practice pointers, not a fake personal history.
Bonus fix: `Position/utils.ts renderEmphasis` rendered literal `**` around bold-wrapped neg
spans ("**$418 of bitcoin was sold**") — normalized.

### #2 — no standalone swap UI (ruling: lending UI first)
Sierra reasoning recorded: the redemption-legibility constraint is about the *borrower's*
surface (when your debt is redeemed against, you must see debt shrink and collateral stand
still) — that now lives in the YourRecord redemption renderer, not in a swap page. A standalone
swap UI is trader plumbing with weak rule-8 standalone value; defer until the lending UI is done.

### #4 — points ruling: formula still evolving; leaderboard framing re-audited once it settles.

### #5 — dead surfaces removed (owner-approved)
Deleted: `components/SideNav.tsx`, `components/Header.tsx`, `components/Stake/Staking copy.tsx`,
`pages/bid.tsx` + `pages/management.tsx` (redirects to routes that don't exist),
`pages/[chain]/headquarters/`, the Bridge dead link in `CyberpunkLevelsData.ts`, stale robots
lines, and the dead CyberpunkHome internals (commented LobbyView, unreachable AboutView,
`handleReceptionist`, `handleElevator`, the `'about'` view branch — 1172 → 513 lines, verified
no external importers, typecheck clean).

## Still open (data/backend work, tracked)

1. The §2 event pipeline (price-history sweep → named events → per-user outcomes) — the
   `usePositionEvents` contract is its frontend landing pad.
2. Real Transmuter swap surface — deferred behind lending UI (owner ruling above).
3. LearnTab FAQ render-not-tell — blocked on the mock-data flags flipping (see re-grade note).
4. Points leaderboard rule-7 audit — deferred while the formula evolves.

## Blocked / needs owner decision (superseded — see rulings above; kept for history)

1. **P0-10 — retrospective + rescue attribution on the live borrower path.** The correct content
   exists (`Position/fixtures.ts` Encounters/Calibration/DittoRecap) but wiring it to real events
   needs a position-history/event data source that does not exist in the app today. Adding one is
   a new data dependency → owner decision. This remains the top structural gap; the roadmap for it
   is already written (`docs/DOPAMINE_LOOP_ROADMAP.md` §2).
2. **Real Transmuter swap UI with debt-only redemption rendering** (P0-4 second half) — the
   transmute path exists only in `components/Earn/hooks/useCDPRedeem.ts`; building the surface is
   new scope.
3. **P1-8 — borrower-facing liquidation history** ("what happened to my position") — same data
   dependency as P0-10.
4. **P1-9 — Points formula** is server-side; frontend evidence says points scale with dollars
   moved. Verify the backend formula before deciding whether the leaderboard violates rule 7.
5. **P1-11 — EpochRevenueCard "faulty stat" APR** — computing the correct lock-boosted APR needs
   the lock-time boost curve; showing a number the tooltip disavows should be replaced, not
   re-explained, once that curve is available client-side.
6. **P2 dead surfaces** (`SideNav.tsx`, `Header.tsx`, `Staking copy.tsx`, dead CyberpunkHome
   views, `/management` + `/bid` dead redirects, `/headquarters`, Bridge dead link) — deletion
   requires the owner's per-surface sign-off per the audit constraints.
