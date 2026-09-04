# Carry facts for @brane_trix — September 2026

Each block: draft copy (edit freely) + a `src:` line you can strip before posting.
Tags: **[measured]** our on-chain recorder or measured research — safe to state flat.
**[modelled]** our model, not a measurement — keep the hedge word if you post it.

Suggested thread spine: **1 → 4 → 7** (flow is a torrent → the gate got tested and
held → there's a size where the ranking flips).

---

## Exit reality (our venue recorder, Sep 2026)

**1. [measured]**
"Sticky TVL" is netting doing your thinking for you. sUSDS holds ~$4.7B — and served
$33.5B of exits in 90 days. The whole vault's worth of capital walks out roughly every
13 days.
`src: venue_flows, sUSDS 2026-06-04→09-04, out $33.5B / in $31.8B, 70k events`

**2. [measured]**
Worst single exit day we've recorded: $833M left sUSDS on July 13. Served. Five of the
six biggest exit days in our corpus are sUSDS days from one June–July stretch.
`src: venue_flows daily out sums; top-6 days`

**3. [measured]**
Ethena's sUSDe paid out $9.0B against $6.1B in over the last year. The net −$2.9B
matches the vault's collapse from $4.2B to $1.4B — two independent on-chain sources,
one story.
`src: venue_flows sUSDe 2025-07-26→2026-09-04 vs venue_snapshots totalAssets`

**4. [measured]**
On March 18, 2026 Ethena quietly cut the sUSDe cooldown from 7 days to 1. Five weeks
later came the year's biggest exit wave — $1.48B out in 7 days. The shorter gate
cleared it. That week is the best observed evidence the 1-day cooldown works at scale.
`src: venue_snapshots cooldownDuration transition (archive-dated); worst 7d window ending 2026-04-25`

**5. [measured]**
90 days of watching Aave's USDe reserve: the worst day drained 26% of available
liquidity ($53M out, $205M sitting there). "Instant exit" held. But that's a history,
not a guarantee — check it per-venue, per-size, every time.
`src: daily outflow ÷ nearest instant_usd snapshot; peak ratio 0.259 on 2026-07-10`

## Carry economics (measured route/position corpus, Aug 2026)

**6. [measured]**
The best route on our board nets 11.53%. The most crowded route nets 3.44% — with 182
positions in it vs 15. The crowd isn't dumb: the 11.53% route's exit is thin. Depth is
priced by the people who've been burned before.
`src: Aug 2026 route table, 1,245 positions / 25 priced routes`

**7. [modelled]**
There is a dollar size where the venue ranking flips. Model exit cost into the return
and the high-yield venue loses to the deep venue somewhere around ~$600k. Size by APY
alone and you're reading the one chart that can't show you this.
`src: crossing model (measured APRs + modelled depth tiers) — NOT a measurement; keep "around"`

**8. [measured]**
A third of the routes on our measured board are negative — including one at −3.75%
whose yield module was confirmed earning exactly 0%. There are positions in them right
now.
`src: route table, 4 of 12 board routes net-negative; GHO→UmbrellaStakeToken note`

**9. [measured]**
63% of real carry positions required an in-transaction swap to even get built. The
barrier to carry isn't finding the spread — it's the plumbing.
`src: 302 atomic carry positions traced`

**10. [measured]**
Carry exists — 47% of stable pools beat their borrow cost. But TVL-weighted, the
average carry spread is −0.36%. The good venues fill; the marginal dollar earns
nothing. Finding CAPACITY is the skill, not finding yield.
`src: lending-market carry scan`

## What actually kills positions

**11. [measured]**
Across 521 real PT liquidations clearing $39M, bad debt from liquidation mechanics
totaled $1,979. The $5.7M loss in the same dataset came from the collateral's own
credit going bad. Venue risk eats principal; liquidation risk mostly doesn't.
`src: Morpho PT liquidation backtest incl. USD0++ depeg; RLP underlying-credit loss`

**12. [measured]**
3,326 closed positions: age dominates closure 44× over any other factor. Drawdown is a
threshold, not a gradient. People don't bleed out — they cross a line, or they outlive
the trade.
`src: position-closure study`

**13. [measured]**
Depositors are yield-inelastic (flow↔yield correlation ≈ −0.06). One savings vault
underpaid its benchmark by 140bps for 366 straight days and grew 159%. Convenience
beats rate. Venue selection is where the alpha lives, not rate-chasing.
`src: savings-vault stickiness study, sUSDS`

**14. [measured]**
66% of carries on Morpho use collateral Aave doesn't even list. Listing breadth drives
the trade — the "predictability gap" between venues explains almost none of it.
`src: collateral-listing study`

**15. [measured]**
In stress, lenders leave but borrow rates don't spike. The danger signal isn't the
rate chart — it's the liquidity walking out the door. Rate dashboards watch the wrong
number.
`src: venue-stress flow study`
