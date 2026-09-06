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

## Owner precision rulings (2026-09-06) — VERIFICATION VERDICT: not yet shipped

**The code check (2026-09-06, cited) found rulings 2 and 3 describe the Mycelium
target design (HP-1 / HP-30 / HP-43 in membrane-solidity's
docs/DEPLOYMENT-VAULT-HONEYPOT-DESIGN.md), NOT the deployed contracts.** What the
shipped code does today:
- One rate for ALL debt, deployed or idle — segment rates come from
  `_positionEffectiveRate` (Cdp.sol:4496-4532; accrual walks every segment
  unconditionally, Cdp.sol:4347-4396). `deployedTo[]` is explicitly
  informational (Cdp.sol:336) and never feeds interest.
- The only yield-linked charge is the user-set keeper fee (≤5%,
  DeploymentVaultBase.sol:817-896) — vault yield PAYS DOWN the loan (RepayCdp
  intent), it is not a cost-as-share-of-yield skim. **If venue yield < borrow
  rate, carry goes negative — nothing in code prevents it.**
- The base rate is governance-mutable (cdp.base_interest_rate, Cdp.sol:4691-4695)
  and the avoidance-rate floor moves with the market (CuratorRegistry:808-835,
  partly shipped) — so today, every rate dial in code moves.

**Consequences for the copy, until the protocol work ships:**
1. "LTVs move but delayed" — still under verification (gate 3 agent), unaffected.
2. "Yield moves but never the % spread" + 3. "No negative carry possible" —
   MUST ship future-flagged (Mycelium model) or not at all. Present-tense use
   would be false against the deployed contracts.
   Code-supported interim wording:
   > "Deployment-vault yield is routed to pay down your loan automatically; the
   > base borrow rate tracks the calm floor of the deployment market rather
   > than a spiking utilization curve."
**Decision open (owner):** ship the copy future-flagged, or build HP-1
(zero-base-interest cutover) + HP-30 (charge on gains only) + HP-43 (negative
carry impossible by construction) in membrane-solidity — W1 of the honeypot
memo, change-control governed — so the USP's spine becomes present-tense true.

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
3. **Fixed-at-open vs can-move — INVENTORY VERIFIED (2026-09-06, cited). The
   rendered-table content:**

   **FIXED AT OPEN (present-tense true today):**
   | What | Mechanics | Cite |
   |---|---|---|
   | The rate on debt you've drawn | snapshotted per draw segment, never repriced; base/adaptive moves touch NEW draws only. (Fixed-rate segments re-stamp at their own endTime — say so.) | CdpInternal.sol:50-61, Cdp.sol:4417-4420 |
   | Liquidation caller-fee shape | LTV-ramp formula, 20% cap — code constants | LiquidationEngine.sol:1505-1510 |
   | The ceilings themselves | 90% LTV hard cap, 5% liq-fee cap, 100%/yr rate cap, 10%/update oracle deviation, 1h staleness — immutable by owner AND governance | Constants.sol |
   | Revenue collected, never minted | fees split out of actual repayments; no path debits your principal to pay a fee; share ceilings code-capped (5%/50%) | RevenueDistributor.sol:489 |
   | temp_ltv + wired sinks | immutable post-registration / SET-ONCE | Collateral.sol:222, SinkAlreadyWired |

   **CAN STILL MOVE (who · delay · blast radius):**
   | What | Who/delay | Reaches an open position? |
   |---|---|---|
   | Liquidation LTV (owner ruling CONFIRMED: "moves but delayed") | Disco stake-weighted; direct lowering FORBIDDEN in code — 14d request + 2d window; unstake-driven drift ≥7d notice | **Grandfathered until touched**: liquidate() reads your CACHED LTV; your next deposit/withdraw re-stamps to the live value (LtvDisco.sol:1192,1210; Cdp.sol:2171,1308) |
   | Base/adaptive interest rate | 14d+2d timelock / autonomous controller | New draws only — never your drawn debt |
   | Static liq protocol-fee | timelock, ≤5% hard cap | future liquidations of open positions |
   | Supply caps | AUTONOMOUS cap-voter, no timelock | a cut can BLOCK partial withdrawals while aggregate sits over the new cap (Cdp.sol:1393-1400) — a real exit-side hazard; state it |
   | Oracle route set | Disco-vote autonomous; 10%/update deviation bound | live prices, incl. solvency checks |
   | Revenue split level | timelock, within code caps | go-forward yield share; never principal |
   | Collateral `enabled` toggle | governance | **UNVERIFIED effect on open positions — gap being closed; do not ship the headline until it is** |
   | Vault venue set / UUPS | delayed-upgrade timelock | only if routed through that vault |

   **Present-tense honesty banner for the rendered table:** owner renounce has
   NOT happened yet — today the two-role owner/governance model with 14d+2d
   timelocks governs; "frozen forever" is the launch endpoint, not the current
   state. Date-stamp the table and re-render when renounce lands.
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
