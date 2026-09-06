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
| Exit | A stuck venue costs you time, not a penalty (verified wording below). | /venue pages + recorder corpus | ✓ verified vs contracts — see gate 2 |

## Owner precision rulings (2026-09-06, mid-review)

These three sentences are the spine of the fixed-vs-movable story — each under
code verification before public use:
1. **"LTVs can move — but delayed."** The cap dial's honest form: the algorithm
   updates borrow_LTV, and updates reach open positions with a delay, never as an
   instant cut. (Verification in flight: exact delay mechanics + citation.)
2. **"The yield can move, but never the % spread."** Cost is taken FROM yield as
   a share, so the user's spread proportion is structural. Yield level = market's;
   spread share = nobody's dial. (Verification in flight: where the skim fraction
   lives + whether governance can touch it.)
3. **"No negative yield is possible."** Cost ≤ yield by construction — the carry
   cannot be underwater on cost. (Same verification.) Base interest applies only
   to UNDEPLOYED debt per owner; being double-checked in code.

## Honesty gates (must clear before public)

1. **Fuse the contradiction — CLEARED, shipping wording:**
   > "De-risking never sells your collateral. When the protocol pulls risk down,
   > it recalls capital it issued on the debt side — there is no mechanism by
   > which your collateral becomes exit liquidity. Insolvency is different, and
   > we say it plainly: cross the line and collateral IS sold — through an
   > 8-hour window, inside a price band, and only as much as it takes. You get
   > liquidated for being insolvent, not de-risked into being smaller."
   One breath, both truths, above the fold.
2. **Exit dial — VERIFIED against membrane-solidity, 2026-09-06 (verdict:
   supported-with-precision).** The delay adds NO venue-induced cost anywhere in
   the contracts: no waiting fee (over-liquidity withdrawal simply reverts and you
   take what's liquid — DeploymentVaultBase.sol:330-351), no cure-window premium
   (the window stores only startTime, nothing accrues — LiquidationEngine.sol:
   1410-1419), a liquidation fee keyed to LTV crossed, never to time waited
   (LiquidationEngine.sol:1505-1515), and a cost-free sUSDe cooldown path
   (DeploymentVaultUSDe.sol:82-95). The port even DELETED the Rust time-based fee
   on purpose — the code comment says it "would let the delay window mint a hidden
   base rate" (LiquidationEngine.sol:1496-1497). Marketable in itself.
   The one precision: ordinary borrow interest (default ~1%/yr, Cdp.sol:875,
   accrual Cdp.sol:4347-4396) keeps ticking on open debt, identically whether the
   venue is healthy or stuck, and is stoppable by repaying — which needs no venue.
   The absolute "doesn't get more expensive" is therefore replaced by this
   SHIPPING WORDING:
   > "A stuck venue costs you time, not a penalty. When a venue can't return
   > capital right away, we don't charge you for waiting — no exit fee, no
   > cure-window premium, and your liquidation price doesn't ramp just because
   > the clock is running. The delay is a delay. (Your loan's normal interest
   > keeps accruing on any debt you leave open, exactly as it always does — and
   > you can repay to stop it without waiting on the venue.)"
3. **"Fixed at open vs. can move" ships as a rendered TABLE, not prose** (owner's
   second note, in house teach-don't-tell form): left column what is immutable at
   position-open; right column what still moves (MBRN governance, the autonomous
   listing process — with their gates/timelocks named). Dated. This table is also
   the strongest screenshot artifact the USP produces — no competitor can publish
   it honestly.
4. **Source URLs — PINNED (verified 2026-09-06; all five claims stand, three
   precision notes for the copy):**
   - **Rate spike**: numbers exact ("roughly 3.5% to 14% within 48 hours" — NYDIG).
     Precision: the exploit was KelpDAO's rsETH bridge ($292M, Apr 18 2026), which
     hit Aave via deposited collateral — say "an exploit in another protocol's
     asset", not implying Aave itself was exploited.
     https://www.nydig.com/research/the-butterfly-effect-comes-to-defi ·
     https://governance.aave.com/t/arfc-improve-liquidity-buffer-for-usdc-on-aave-v3-ethereum-core-raise-slope-2-lower-optimal-utilization/24684
   - **TokenLogic 5.25%**: number exact. Precision: it phases in at 10bps/day over
     ~2 weeks — "hard-coding the curve to a 5.25% target, phased in over roughly
     two weeks" is the precise form.
     https://governance.aave.com/t/risk-stewards-august-2026-stablecoin-interest-rate-adjustments/25519
   - **LlamaRisk Aug-10 caps**: all three numbers exact, no correction.
     https://governance.aave.com/t/risk-stewards-supply-and-borrow-cap-reductions-on-aave-v3-2026-08-10/25463
   - **DeFi Saver**: 0.3% both directions confirmed (Maker + Aave automation
     specifically — don't imply universal flat rate); 697.49 WETH / $1,965,378
     save confirmed, dated Jan 29 2026.
     https://help.defisaver.com/protocols/makerdao/how-does-cdp-automation-work ·
     https://blog.defisaver.com/defi-saver-case-study-the-role-of-automation-during-mass-liquidation-events/
   - **Black Thursday 5.67M DAI**: defensible, footnote it as the SYSTEM DEBT
     SHORTFALL (other circulating figures: $4.5M unbacked day-of, $8.3M ETH taken
     by zero-bid winners — different measurements, not contradictions).
     https://www.coindesk.com/tech/2020/03/13/makerdao-debts-grow-as-defi-leader-moves-to-stabilize-protocol ·
     https://pharos.watch/learn/case-studies/dai-black-thursday/

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
