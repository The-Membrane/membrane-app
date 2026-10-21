# Risk Frontier: final design for position what-if scenarios

> **Status:** design proposal, 2026-10-04. Not built. It comes from the owner's vision: a "Bloomberg-style swatch of what-if scenarios… a tree of future possibilities… how close positions are to high-risk scenarios… realtime venue changes and market moves."
> **Method:** a design workflow mapped the reusable code and data, then three independent designs (stress grid, branching tree, historical analog) were scored by three judges (feasibility, user value, credibility) and merged here.
> **Verified by the parent session:**
> - `cureWalk` is at `lib/position-sim/curePath.ts:278`.
> - `runComparison` is at `lib/position-sim/compare.ts:412`.
> - `membrane.ts:31` still has `MAX_LTV_HARD_CAP = 0.9`.
> - `launchctl list` shows **only** `com.membrane.holder-exit-campaign`, so the hourly venue recorder is NOT loaded and the live venue feed may have stopped. Fix this first (MVP week 0).
> **Inputs:** `membrane-solidity/docs/RESEARCH-DEFI-DOJO-COMMUNITY.md` §F4 (verified user data needs); the Recall Coverage Dataset spec (artifact `Lm9KrFSbw9zp2FtWhcd3Nm`, unratified); `docs/research/venue-capacity-drivers.md`; `docs/POSITION_SIMULATOR.md`.


## 1. Concept

The **Risk Frontier** places the user's live position inside a map of fixed, named stress scenarios: price shocks, squeezed or frozen venue exits, and replayed crash shapes. For each axis it shows how far the position is from the shock that opens the delay window or forces a sale. Every node runs through Membrane's mechanics (delay window, recall, the 3pp gap, exposed slice in $). Each node reproduces from its key. When the position, a venue or the market moves, the "you are here" marker moves, distances shrink or grow, branches change colour, and a change card says why. It is the Bloomberg what-if swatch drawn as a tree. It shows mechanics, not odds.

## 2. Merged design

- **Spine: the stress-grid engine (deterministic).** The judges found it the most buildable. It needs no calibration the data can't supply (there are no venue stress events), and it is cheap enough to run on the client.
- **Shell: the branching-tree interface.** Both the user-value and the credibility judges scored it 8/10.
  - **Layout:** one sentence naming the nearest risk, then a gauge, then the tree one tap down.
  - **Cheap ticks:** the frontier is an absolute price, so a price tick only moves the marker.
  - **Staleness rule:** a stale branch is hatched, never green, and the headline is suppressed. This fixes stress-grid's worst flaw: green cells on a stopped recorder.
  - **Margin:** distances are rounded toward risk.
- **From analog-replay:**
  - **Novelty banner.** It is built from ETH/BTC drawdown quantiles, never from analog counts, because counts read as odds.
  - **Scored snapshots.** Each issued snapshot is scored against persistence. This is the only pipeline that builds toward the forecast gates.
- **Swatch:** kept as the power-user tab, with the same cells and keys.
- **Fixes the judges asked for:**
  - The combined "cheapest route to red" is dropped. It hid an exchange rate between the price axis and the venue axis. Combined cases appear only as named scenarios.
  - The headline compares the recall needed with the capacity observed, and adds "modelled, not a guarantee".
  - No "ok" or "safe" wording. Distances are whole %.
- **Additions** (from the user-value judge, based on Dojo demand):
  - **Reverse solve:** the highest LTV that sees no sale at −50% and at −60%.
  - **Leveraged-ETH mode:** no recall rows.
  - **Exit-queue axis:** first item in v2.

## 3. Main view

```
12 ETH → 31.4k CDT · LTV 71% · line 86% · 8h-delay class · Aave USDe deployed $14.2k
modelled on master 32056e97 · prices 41s old · venues 52m old           (illustrative)

NEAREST RISK  ETH −17% (≈$3,060) opens the 8h delay window. Recall would need $9.8k;
              Aave USDe showed $4.1M instant exit, present 22 of the last 24h.
              Modelled recall, not a guarantee.

DISTANCE TO DANGER   smallest single shock that changes the outcome · not a probability
 ETH price     now●─────17%─────▲window─────13%─────✖sale  $2.1k exposed
 Venue exit    now●──── capacity −62% ────✖recall short $4.0k
 Venue freeze  now●──── 19h ────✖recall misses the window
 Crash test    no sale at −50% up to LTV 44% · you are at 71%     [reverse solve]
 7-day trend   ▇▆▆▅▃▃▂  window distance −22% Mon → −17% now   ⓘ change card

TREE                    1h               8h (window)              24h
 now ─┬─ flat           ● ─────────────── ● ─────────────────────── ●
      ├─ −10% step      ● ─────────────── ● ─────────────────────── ●
      ├─ −25% step      ▲ armed ──┬─ recall clears ──────────────── ▲ cured
      │                           └─ venue exit ×0.1 ────────────── ✖ sale $6.3k
      ├─ −25% wick→4h   ▲ armed ─── price recovers ─────────────── ▲ cured
      ├─ Oct-10 shape   ▲ ─────────────── ▲ cured        [mechanical sensitivity test]
      └─ sUSDe freeze   ░ venue data stale: not coloured
 NOVELTY (v2)  24h ETH move in the top 2% of 2023–26 hourly history

● no breach in this scenario   ▲ window armed, then cured   ✖ collateral sold ($ shown)
░ not modelled or stale (reason shown) · equal-width branches · no weights
Stress scenarios: not forecasts, not probabilities.         [ Tree ⇄ Swatch ]
```

- **96% no-delay class:** there is no ▲. Arming the window and the sale are the same point, shown as "crosses line → immediate".
- **Colour-blind reading:** every colour carries a glyph.

## 4. Engine data flow

```
POSITION   adapters/ Aave V3·Spark·Morpho·Comp V3 ...... EXISTS (Fluid stub)
           detectVenues (ERC-20 balances only) ......... PARTIAL (recall modelled)
           sandbox overrides ........................... EXISTS
LIVE VENUE venue_snapshots ×5 + venue_alarms ........... PARTIAL (recorder not loaded;
                                                          cooling/stranded derived)
MARKET     Chainlink spot via rpcRing.ts ............... EXISTS (stale >6h)
           Oct-10 1m path, ETH/BTC oracle-priced ....... EXISTS
           ETH/BTC drawdown + 8h-recovery quantiles .... NEW (N1 hourly panel)
           irm_params · oracle registry · exit queues .. NEW
               ▼
SCENARIO GENERATOR  Shock{price,capacity,rate,oracle} ...... NEW stressGrid.ts
                    bisection frontier + reverse solve ..... NEW frontier.ts
               ▼
MEMBRANE MECHANICS  membrane.ts class constants ...... FIX (0.9 cap, 8h on every asset)
                    cureWalk curePath.ts:278 .......... EXISTS
                    recall walk E_t §4.2 .............. NEW (spec only)
                    R_cure · R_liq · exposed X §4.3 ... NEW (spec only)
                    runComparison twin compare.ts:412 . EXISTS
               ▼
NODE OUTPUT  class · LTV · $ exposed · recall need vs capacity · time to arm ·
             yield given up · cell_key + code hash · input ages ... NEW store
               ▼
UI           headline · ruler · tree · swatch · change cards
```

## 5. Update loop

| Trigger | Recompute | Where |
|---|---|---|
| Chainlink round, or every 60s | Marker and distances only | client |
| Position change (tx, adapter poll or sandbox drag) | Full frontier and tree (a few hundred `cureWalk` runs) | client |
| Hourly venue snapshot or `venue_alarms` row | Venue leaves, recall rows, change card | server |
| Daily | A salted-hash snapshot feeds the trend line. v2 adds the novelty bucket and persistence scoring | server |
| Stale input (ring >6h, recorder >2h) | Hatch the branch, never show it green, suppress the headline | both |

Alerts are deterministic threshold crossings, mapped to `delay_started` and `venue_capacity_change`. They stay internal until G2.

## 6. Honesty rules

- **Calibrated:** nothing today. The "calibrated forecast" label stays empty.
- **Deterministic:** every node is a stress scenario that reproduces from its `cell_key` plus the code hash.
- **Labelled as modelled or illustrative:**
  - Membrane LTVs, because Membrane is not on mainnet.
  - Recall, because the venue read covers balances only.
  - Historical shapes, labelled "mechanical sensitivity test".
  - Non-ETH/BTC collateral, which is held flat and hatched.
  - Gas, MEV, slippage and interest accrual, all marked as omitted.
- **Withheld:**
  - Probabilities, branch weights, analog counts, win rates, confidence figures and "X% of users".
  - Research forecasters, until the 20-event and 30-paired-window gates pass. After that they appear only as ranges, with n and the sample period.
  - Net carry, because `carryCost.ts` never prices Membrane's side. Only "yield given up" is shown.
  - External alerts, until G2.
- **Never said:**
  - 0% or free borrowing
  - positive carry
  - 93% as a borrow limit
  - an 8h window at the 96% line
- **Always shown:**
  - the code base
  - the exposed slice in $
  - change cards with three labels: measured change, observed driver, possible leading signal

## 7. Roadmap

Recall-coverage phases: P0 → G1 → **P1** wallet surfaces → G2 → **P2** contract parity → G3 mainnet → **P3** `recall_log`.

**MVP (2–3 weeks; existing data only; on the simulator page; part of the P0/P1 build)**
- **Week 0:**
  - Reload `com.membrane.venue-recorder`.
  - Make `membrane.ts` model each delay class, including the 96% no-delay class.
  - Scope E_t, X and `cell_key` as new code.
- **Week 1:**
  - Build `stressGrid.ts` and `frontier.ts`.
  - Scenarios:
    - step, linear and wick price shapes
    - venue freezes of 4, 8 and 24h
    - venue capacity at ×1, ×0.5 and ×0.1
    - the Oct-10 relative replay
  - Add the bisection and the reverse solve.
  - Add tests for monotonicity and reproducibility.
- **Week 2:**
  - Build the UI on a hypothetical Membrane version of imported Aave, Spark, Morpho and Compound positions.
  - Support ETH/BTC collateral only.
  - Add leveraged-ETH mode and hatching for stale inputs.
- **Week 3:**
  - Add snapshots, the trend line and change cards.
  - Add the incumbent twin.
  - Build an internal E1 harness.

**v2 (P1 → G2), with the data each item needs**
- **LST exit-queue ledger** (Lido first): the exit-queue axis.
- **Oracle registry:** oracle type, oracle-lag and oracle-switch scenarios, and oracle-change alerts.
- **N1 hourly Chainlink panel** (keyed Ankr): drawdown and recovery quantiles, plus the novelty banner.
- **`irm_params` and interest accrual:** the rate-spike axis, the 7d horizon, and the MR-CODE, MR-CARRY and MR-DESIGN rate scenarios.
- **E1 raw pull, resolved E2/E3 block numbers and new replays:** the E1–E4 stress rail.
- **Alert back-test, with the false-alarm rate over 30 calm days:** this passes G2, which unlocks the wallet surface and the `frontier_proximity` alert.

**v3 (P2 → P3)**
- **P2 contract parity:** `cureWalk` and E_t must match LiquidationEngine on anvil fixtures. The P2 safe LTV feeds the reverse solve.
- **P3:** `recall_log` replaces modelled recall, and positions are read live after mainnet launch.
- **Only after the gates pass:** venue ranges, the 30d horizon and net carry.

## 8. Open questions for the owner

1. Should the tree lead, with the swatch as a tab, or should the literal Bloomberg swatch come first?
2. Should the exit-queue ledger come before the oracle registry and `irm_params`?
3. Until E1 calibration passes, how large a risk-side margin should distances carry? For example, 2pp of price.
4. Should the MVP headline lead with the reverse solve for the leveraged-ETH persona, rather than with recall?
5. Can the MVP go on the public simulator page as a sandbox before G2, or must it stay internal?
