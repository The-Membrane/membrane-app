# The Worst Venues to Have Carried In — Historical Inventory and Pattern

**Date:** 2026-09-04 · **Method:** six parallel research passes (Exa, primary sources
preferred: DOJ filings, protocol postmortems, LlamaRisk/Chainalysis/Chorus One forensics,
contemporaneous CoinDesk/Defiant/Block reporting) synthesized against Membrane's own
measured corpora (venue recorder, PT-liquidation backtest, Aug-2026 route table).
**Tags:** MEASURED (primary/on-chain, multi-source) · REPORTED (named outlet/protocol,
not re-derived) · ESTIMATE (analyst modeling) · CONTESTED / THIN where flagged.
**Prongs:** composition (the assets weren't what they seemed) · withdrawal path (the
mechanism gated or broke) · delivery (capacity existed on paper, absent under load).

---

## 1. Incident table

| Venue | Date | What the carry trader experienced | Failing prong | Mechanism in one line |
|---|---|---|---|---|
| Anchor/UST | May 2022 | exit slippage 0.3%→22%+ in ~24h; late depositors −80–100% (MEASURED, NBER w31160) | **composition** → delivery | 19.5% "yield" was a depleting subsidy reserve; UST's backing (LUNA) was inflated by the yield it funded |
| stETH / Celsius | May–Jun 2022 | discount to record 8%; Curve pool $4.6B→$621M (−85%), ratio 78:22; Celsius froze Jun 12 (MEASURED) | **delivery** + structural path | no redemption channel existed pre-Shapella; the only exit was one secondary pool that drained under forced selling |
| MIM depegs | Jan + Jun 2022 | Curve exit effectively gone (pool 90–96% MIM); ~$12M alleged bad debt (REPORTED, unverified) | **delivery** + composition | one-sided AMM = stated $1 capacity absent; degenbox backing self-referenced UST |
| Mango Markets | Oct 2022 | ~$110M drained (MEASURED, DOJ); protocol self-froze; DAO treasury subsidized make-whole | **delivery** | oracle marked MNGO at a price no market depth supported; real assets borrowed against the paper mark |
| Euler | Mar 2023 | $197M drained; withdraw hard-disabled ~3 weeks; bespoke merkle redemption; ~100% recovered only because attacker returned funds (MEASURED) | **withdrawal path** | post-audit `donateToReserves()` skipped the health check; exit welded shut while negotiating |
| Angle agEUR (via Euler) | Mar 2023 | 74% of USDC reserves in ONE strategy; −$17.6M; mint/burn paused indefinitely within ~1h (MEASURED, LlamaRisk) | **composition** → path | single-venue reserve concentration; saved only by Euler's recovery |
| Yearn legacy yUSDT | **Apr 13** 2023 (not Feb — corrected) | ~$11.5M; legacy vault share price destroyed (MEASURED) | **composition** | iUSDC wired where iUSDT belonged, dormant ~1,000 days, outside audit scope |
| Iron Bank / Alpha | freeze Mar–May 2023 | $41–80M frozen ~2.5 months; settled in vesting ALPHA + fee share, not principal (MEASURED terms) | **withdrawal path** | admin key repurposed to freeze depositors over a protocol-to-protocol credit dispute |
| CRV / Egorov | Jul–Sep 2023 | NEAR-MISS: no principal loss; Fraxlend lenders gated at ~100% utilization | **composition** root, delivery proximate | founder loan = 34% of CRV's own mcap vs ~$27M on-chain depth |
| Curve Vyper pools (LP side) | Jul 2023 | ~$70M drained, pools emptied; NO pause existed to protect (MEASURED, LlamaRisk) | **withdrawal path** | compiler-level reentrancy corrupted exit accounting |
| USD0++ (Usual) | Jan 2025 | $1→$0.90; Morpho market-oracle borrowers liquidated at 86% LLTV; docs silently edited pre-change (MEASURED + DL News archive diff) | **withdrawal path** + composition | redemption terms rewritten unilaterally mid-flight (1:1 → $0.87 floor); 4-year term instrument priced as par |
| Ethena/Binance | Oct 2025 | $0.60–0.68 on Binance ONLY; <30bps on-chain; ~$346M venue liquidations, $283M reimbursed (MEASURED, LlamaRisk) | **delivery**, venue-localized | exchange's self-referential oracle fed its own thin book into the liquidation engine |
| Stream xUSD | Nov 2025 | −77%/24h → −92%; frozen since Nov 4 2025, no repayment as of mid-2026; $93M loss vs $160M real deposits, ~4x recursive mint (REPORTED, contested as misappropriation) | **composition** → path | opaque single-manager off-chain book; hardcoded ~$1 oracle disabled loss containment |
| Elixir deUSD | Nov 2025 | −98%; 65% of backing secretly lent to Stream; 80% redeemed pre-halt, late claimants ~80% recovery (MEASURED/REPORTED) | **composition** → path | self-referential backing; issuer severed redemptions to stop the run |
| Morpho "safe" vaults (Steakhouse/Gauntlet) | Nov 2025 | ZERO losses; briefly illiquid; utilization 100%, rates ~190% APY; 80% of withdrawals in 3 days (REPORTED, Chorus One) | **delivery** (duration mismatch) | isolated markets pool UX, not liquidity; idle cash exhausted by correlated exits |
| Resolv USR/wstUSR | Mar 2026 | $25M unbacked mint (key compromise); Fluid $21M bad debt (repaid $19.3M), Morpho ~$6.2M; allocators refilled broken markets for hours (REPORTED/ESTIMATE) | **delivery** (propagation) | hardcoded/stale oracle held $1.00–1.13 while USR traded $0.03–0.63; 4th stale-oracle-at-par incident in 14 months |
| Morpho PT-reUSD | Aug 2026 | $36.14M liquidated in 14 min, 33 events, zero lender bad debt; ~9–11x loopers lost ~21–26% of equity to the penalty (MEASURED via Morpho API; per-position ESTIMATE) | **delivery** | 15-min TWAP priced off an $8.97M pool against a $67.5M book; a $320K trade moved the mark 3% (manipulation CONTESTED) |
| Morpho VaultV2 `maxWithdraw`=0 | Nov 2025–Apr 2026 | integrator deposits treated as non-withdrawable though liquidity existed; realized-loss magnitude UNCONFIRMED | **withdrawal path** | spec-compliant view function returned 0 by design; integrators following ERC-4626 literally never attempted the call |
| Moonwell double oracle failure | Oct–Nov 2025 | >$5M bad debt (ESTIMATE) — **THIN**: no dedicated postmortem found; do not cite without follow-up | likely delivery | flagged in four roundups, all tracing to one line |

Source URLs for every row are preserved in the underlying research sections (six
reports, this session); the load-bearing ones: NBER w31160 (Anchor), LlamaRisk
(stETH/Angle/Ethena-Binance/Curve), DOJ SDNY complaint (Mango), Euler "War &
Peace" + redemption forum, Alpha open letters (Iron Bank), DL News doc-archaeology
(USD0++), Chorus One curator report (Nov-2025 contagion), Resolv postmortem +
Nexus Mutual (USR), The Defiant + Morpho API (PT-reUSD).

---

## 2. The pattern, ranked by incident count

**P1 — The oracle marks what the exit can't pay (7 incidents: Stream, Resolv,
USD0++, PT-reUSD, Mango, Ethena/Binance, Moonwell-thin).** The single largest
predictor of carry loss, and it fails in BOTH directions: a hardcoded/stale price
lets bad debt accumulate silently because liquidation never fires (Stream, Resolv,
USD0++); a market-derived TWAP against a thin pool transmits a $320K trade into a
$36M cascade (PT-reUSD, Mango). Neither extreme is safe. The discriminator for
hardcoding is whether the fixed price reflects an enforceable redemption promise —
Aave's USDe=USDT hardcode *prevented* the Binance cascade from reaching on-chain
borrowers because Ethena's mint/redeem actually pays; Stream's $1 hardcode was a
promise nobody could keep. Cited best practice: deviation-triggered pause (Kamino's
±1% on USDe) instead of either extreme.

**P2 — The gate moves, or was never there (8 incidents, two genres).**
Absent-when-needed: stETH pre-Shapella (no redemption channel existed), Curve
Vyper pools (no pause to protect LPs), VaultV2 `maxWithdraw` (exit invisible to
integrators). Moved-mid-crisis: Iron Bank (admin froze depositors over a third-party
dispute), USD0++ (redemption floor cut 1:1→$0.87 by code change), Angle, Elixir,
Stream (freezes). The dossier question is not "is there a gate" but **who can move
it, how fast, and does anything in the exit path start it automatically**.

**P3 — Self-referential or opaque composition (6: Anchor, MIM, Mango-collateral,
CRV, Stream, deUSD).** The asset's backing depends on the asset's own ecosystem
staying up — LUNA under UST, CRV as 34% of its own float, deUSD lending to the
protocol that backs it, a founder's own token as system collateral. Modern variant
(2025–26): the opacity is a *curator's* undisclosed rehypothecation rather than a
protocol's tokenomics.

**P4 — Book size vs. oracle-market depth mismatch (6, and it is the most
actionable):** stETH's Curve ratio drifting 50:50→78:22 in public view; Egorov's
$168M against $27M of depth; PT-reUSD's $67.5M book against an $8.97M pool —
posted on the Morpho forum with a reproducible query **eight days before** the
cascade; Stream's $520M float over $160M deposits; MIM's 96% pool skew; Fraxlend
utilization walking to 100%.

**P5 — Speed-stratified outcomes (recurring in every run):** Anchor's early
exiters paid slippage, late ones lost everything; Elixir redeemed 80% of holders
pre-halt, late claimants took the haircut; Morpho's queues cleared first-come.
Exit speed is a return; monitoring buys speed.

**P6 — Curator/allocator amplification (2025–26 genre):** top curators hold
43–77% of curated TVL (ESTIMATE range across reports); auto-allocators refilled
Resolv's broken markets for hours; "isolated" vaults share curators, so one bad
collateral call crosses walls that liquidity doesn't.

**P7 — Yield that doesn't move with markets (2 strong: Anchor 19.5% fixed, Stream
18% flat while peers paid 3–5%).** Market yield breathes. A flat line is a subsidy
or a fiction.

---

## 3. What would have warned you — and what our recorder should watch next

| Signal (all were public before the event) | Incidents | Recorder status |
|---|---|---|
| Oracle-market depth vs. book size ratio | PT-reUSD (forum post, T−8d), CRV, stETH, MIM | **ADD**: per-venue "what prices this collateral and how deep is it" snapshot |
| Lending utilization → 100% | Fraxlend, Morpho Nov-2025, USD0++ markets | **ADD**: utilization for lending-type venues |
| Float vs. real-deposit / backing ratio | Stream 3.25x, Anchor reserve runway | partial: totalAssets vs totalSupply recorded |
| Pool composition skew | stETH 78:22, MIM 96% | **ADD** where a venue's exit is one AMM |
| Redemption-terms document changes | USD0++ (docs silently edited pre-change) | **ADD**: terms-page hash watcher (cheap, high value) |
| Oracle staleness window | Resolv (15h stale pre-exploit) | ADD for venues with NAV oracles |
| Yield flatness vs. peers | Anchor, Stream | derivable from data we already show |
| Disclosed-but-unactioned infra changes | Binance oracle plan announced Oct 6, crash Oct 10 | this is the venue NEWS feed's job |
| Cooldown/param changes | Ethena 7d→1d (our recorder dated it: 2026-03-18) | **LIVE** — venue_events |
| Warned-and-ignored analyst posts | Schlagonia T−172d (Stream), Gauntlet Jan-2023 (CRV), SrAugust T−8d (PT-reUSD) | news feed adjacency; the archive makes them citable |

**The residual with no signal:** pure code defects — Euler's post-audit function,
Yearn's 1,000-day-dormant miswire, the Vyper compiler bug. No dashboard catches
these. The historically supported mitigations are position sizing and venue
diversification, and (Euler's lesson) audits scoped to *changes*, not just launches.

---

## 4. Non-findings — patterns the record does NOT support

1. **High headline yield alone does not predict failure.** Ethena paid 27% and
   survived everything including the Oct-2025 crash ($2B redeemed in 24h, "zero
   issues," <30bps on-chain); Anchor paid 19.5% and died. The discriminator is
   the yield's *source and variability*, never its level.
2. **UST-pattern-matching failed as a predictor.** The loudest 2024 "next UST"
   calls (Ethena) were wrong; the actual next composition failures (Stream, deUSD)
   drew almost no pre-collapse mainstream warning. Vibes-based resemblance is
   noise; mechanism analysis (funding history, backing attestation, float ratios)
   was the signal.
3. **Audits do not clear venues.** Euler had five auditors; the fatal function
   shipped after scope closed. Yearn's miswire predated and outlived its audit.
4. **Isolation does not equal liquidity** — Morpho's design contained MEV
   Capital's loss to ~$700K (isolation worked) while simultaneously queuing
   withdrawals at *unexposed* vaults (isolation starved liquidity). One design
   choice, both edges, same week.
5. **Liquidation mechanics are rarely what destroys principal.** Across this
   inventory and our own PT backtest (521 liquidations, $39M cleared, $1,979
   mechanics bad debt), traders lost money to composition and gates, almost never
   to a functioning liquidation path. The penalty stings (PT-reUSD loopers,
   ~21–26% of equity at 9–11x); the wipeouts came from elsewhere.

---

## 5. Implications for Membrane (dossier template + recorder roadmap)

Each venue dossier should answer, with evidence or an explicit UNKNOWN:
1. What prices this asset where our users' exit happens, and how deep is that
   market relative to the carried book? (P1/P4)
2. Who can move the exit gate, how fast, with what notice? Has the terms page
   ever changed? (P2)
3. Does the backing reference itself or an unattested off-chain book? Who has
   attested it, when? (P3)
4. Is the yield's source identified, and does the rate move with markets? (P7)
5. What did the venue's worst recorded exit day/week look like, and did the gate
   hold? (our corpus — already live)
The recorder roadmap items marked **ADD** above are ranked by incident count:
depth-vs-book first, utilization second, terms-hash watcher third.
