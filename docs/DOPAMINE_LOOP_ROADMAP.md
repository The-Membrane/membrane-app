# Dopamine Loop Roadmap — Confirmed Decisions (Aug 10, 2026)

Confirmed by EB in session. These extend the roguelike framing settled in the carry builder
(growth you *watch* is inside a run; progression you *keep* is floors + net made) onto the
**live position** surfaces. All items are bound by the User Expertise Ruleset (§11: no
progression on returns, no celebration of unrealized P&L — celebrate process, survival,
debt burned, calibration).

## 1. Per-intent countdown metrics ("days to completion")

Every `YieldIntent` gets a target + countdown derived from harvest throughput — not just
RepayCdp. The debt burn-down / countdown is the dopamine anchor, not portfolio value.

| Intent | Hero metric | Countdown |
|---|---|---|
| `RepayCdp` | Debt as enemy-HP bar; each harvest ticks it down | **Days to self-repaid** (accelerating — saved interest compounds) |
| `Compound` | Deployed stack + net APR | **Break-even day** (cumulative net yield ≥ cumulative borrow interest + fees), then surplus/day milestones |
| `Distribute` | Paycheck framing: "$X/month to your wallet" | Days to next payout milestone / progress vs user-set income goal |

Harvests render as discrete belt-delivery events with an event feed
("+$12.40 from sUSDe → 0.4 days of debt burned"), never a smoothly interpolated line.

**Countdown honesty rule (§7):** "days to self-repaid" is arithmetic off realized harvests
and may render as a single number. Break-even day (Compound) and paycheck rate (Distribute)
are projections off venue APR — the low-validity prong — and MUST render as bands
("break-even between day 41 and 67"), never a single date. Uncertainty in the geometry,
not a footnote. On variable-rate debt the spread can invert during rate spikes (RepayCdp
becomes strictly dominant) — the spread dial should make the inversion visible, and it's a
natural Ditto-nudge trigger.

**Compound vs. repay economics (design guidance):** per dollar of yield routed, the
differential is `(venueAPR − borrowRate)`. Compounding is nominally higher-earning whenever
the carry spread is positive (the condition for the position existing at all), BUT repay is
the risk-free leg — it earns your own borrow rate with zero venue risk and reduces LTV
strictly faster ((D−Y)/A < D/(A+Y)). Surface this as a spread dial on the intent selector,
not a hidden default. "Size first, then chase yield" ordering from the gauntlet applies.

## 2. Retroactive attribution — automated pipeline

The "named encounter" system ("Your position survived the Aug 12 wick — headroom bottomed
at 3.1 hours; your sizing is why") becomes an automated backend job:

- Sweep price history on a schedule; detect qualifying events (vol spikes, drawdowns,
  liquidity locks) and name them.
- For each event, compute per-user position outcomes: headroom low-water mark, hours of
  buffer remaining, whether their sizing was the reason they survived (attribution-to-self
  rule — no silent rescue).
- Persist events + per-user outcomes to the database; populate for ALL users, including
  retroactively on first visit.

**Database double duty (recalled from the "Membrane: App" session):** the same DB also
holds the carry-route economics snapshot (1,245 positions / 25 priced routes — currently a
static Aug 2026 measurement) so the boards/landing route section can be re-measured and
updated periodically instead of shipping stale data. §10 of the ruleset adds position
history and withdrawal-ability instrumentation to the same store.

## 3. Weekly recaps via Ditto

- Weekly run-summary recap (storms weathered, debt burned, headroom low-water mark, ghost
  line vs the you-that-sold) delivered as a **notification surfaced through the Ditto
  avatar** (`components/DittoHologram.tsx`, `components/DittoSpeechBox/`).
- Ditto itself gets restyled/revamped toward a **sprite / familiar / helper** — a companion
  that carries the recap, not a chat box. Recap cards are the shareable artifact
  (Liquity lesson: distribution comes from artifacts other people circulate —
  their frontend-kickback model made every integrator a distributor).

## 4. Brier score as meta-progression

- Calibration score (Brier) is the durable "character level" — shown on the user's
  dashboard, backed by realized outcomes only (§7).
- Trainable: expand the predictive nature of the homepage into a **training grounds** —
  post explicit probability estimates before the week ("P(I breach 80% headroom)"),
  scored after. This is §9.3, previously unbuilt; now prioritized as the retention loop.

## 5. Growth as throughput + dashboard mock

- "Watching it grow" = watching the **machine get faster**: harvests/day, belt speed, the
  loop visibly tightening — not a portfolio line chart. Needs careful design to work.
- Next step: mock a **full user dashboard / portfolio page** containing: throughput hero,
  per-intent countdowns, attribution event feed, Brier/calibration module, Ditto recap
  notification. Handed to the "Membrane: App" session for mocking.
