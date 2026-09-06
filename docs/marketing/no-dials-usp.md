# The No-Dials USP — Membrane's Lead Claim

**Owner, 2026-09-06.** The basis of the USP: Membrane is a Carry Protocol where the
user has control over their position — so the product must empower them to handle it
well. This document is the canonical copy + the surface map (which app page proves
each claim) + the honesty gates that must clear before any piece ships publicly.

## Lead

> **Nobody can change the terms of your position after you open it.**
> Every carry trade in DeFi today has a dial somebody else is holding. A risk firm
> cuts your cap. A rate curve reprices your cost. A bot on someone's server decides
> when you get unwound. You took the trade; they hold the controls. Membrane's
> answer isn't a promise to be careful with the dials — it's that the dials aren't
> there.

## The six dials (expandables) + the surface that proves each

| Dial | Claim (owner copy, condensed) | Proving surface | Status |
|---|---|---|---|
| Rate | Aave USDe: ~3.5%→14% in 48h (Apr 2026), then a governance-patched hard-coded curve. Membrane's cost is drawn from the carry yield itself — no curve to reprice. | Carry hero (cost-from-yield rendering) | ✓ live |
| Cap | LlamaRisk cut sUSDe/USDe caps Aug 10 by someone's decision. Membrane's borrow_LTV derives from the collateral's own measured volatility. | Ladder (rungMetrics on measured tails) | ✓ live |
| Keeper | DeFi Saver: outside bot, 0.3% each fire; Black Thursday zero-bid auctions, 5.67M DAI. Membrane's unwind is in-protocol; the fee comes out of the debt. | Carry timeline (breach→cure→partial) | ✓ live |
| Collateral | Automation elsewhere de-risks by selling (697 WETH at the low). Membrane's yield sits on the debt; recall pulls back protocol-issued capital. | Evidence cohort data + Portfolio YourRecord ("debt −$X · collateral untouched −$0") | ✓ live |
| Timer | One bad tick ≠ liquidation: 8-hour window + price band, then only partial. | **Evidence + ForecastGate** — the star witness: 2,350 real accounts replayed | ✓ live |
| Exit | A stuck venue costs you time, not price; the delay is a delay. | /venue pages + recorder corpus | ⚠ HOLD — see gate 2 |

## Honesty gates (must clear before public)

1. **Fuse the contradiction.** "Your collateral is never the thing that gets sold"
   and "volatile collateral still liquidates" are four paragraphs apart and both
   true. The collateral dial must say it in one breath: *de-risking* never sells
   your collateral — recall pulls debt-side capital — but *insolvency* still does,
   through the window, partially. Above the fold, not a footnote (owner's own note).
2. **Verify the exit dial against membrane-solidity** before it ships: "your
   position doesn't get more expensive while the venue rebuilds capacity" is a
   claim about fee/interest accrual during a stuck-venue recall delay. Cite the
   exact contract behavior (cure-window fee mechanics, recall path) or soften the
   line. UNVERIFIED as of this writing.
3. **"Fixed at open vs. can move" ships as a rendered TABLE, not prose** (owner's
   second note, in house teach-don't-tell form): left column what is immutable at
   position-open; right column what still moves (MBRN governance, the autonomous
   listing process — with their gates/timelocks named). Dated. This table is also
   the strongest screenshot artifact the USP produces — no competitor can publish
   it honestly.
4. Per-example fact-checks before quoting publicly: the Aave Apr-2026 rate spike,
   TokenLogic Aug proposal, LlamaRisk Aug-10 cap numbers, DeFi Saver 697 WETH save
   — each needs a source URL pinned here before the copy goes out.

## Placement (composes with docs/research/carry-userflows.md)

Evidence (landing) restructures FROM "the liquidation-mercy story" TO "the proof
library under the lead":
1. Lead: the no-dials claim (hero).
2. ForecastGate stays exactly as is — it is the timer dial's interactive proof.
3. Six-dial strip: each expandable links to its proving surface (table above).
4. Desire-router doors (→ /radar · /carry · /strats) sit UNDER the lead — the
   claim elicits, the doors route.
Evidence's cohort content is thereby recontextualized, not removed: it becomes the
receipts for dials 4 and 5.
