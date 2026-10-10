# Forecasting a venue exit: repeatable build formula

**Status: implementation plan and evidence contract, updated 2026-10-07.** This is the reusable shape for onboarding a venue; it does not activate a forecast or alert. The [prospective extension proposal](venue-capacity-prospective-v2.md) retains the detailed enrollment and validation gates for calibrated prospective claims. A user's chosen horizon `H` is an input, not a hard-coded two-hour claim. Sampling cadence imposes a minimum supported `H` per source.

## The invariant

Every answer is for **one route, asset, holder state, amount `q`, horizon `H`, and outcome assay**. Changing any one of those creates a different question. A reserve's cash, a vault's `maxWithdraw`, a quoted swap output, and an actual holder withdrawal are separate measurements. No common numeric score may silently merge them.

```text
route identity + q + H + holder/assay
  → verified current observation and complete historical coverage
  → historical backtest or assumption-labelled conditional projection
  → separately: versioned prospective issue and fixed-q outcome
  → chronological, dependency-aware evaluation and censor classification
  → claim level matched to evidence (or an explicit unavailable state)
```

## Build steps for each new venue

| Step                             | Artifact to freeze or implement                                                                                                                                                                                                                                                                                                            | Gate before the next step                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Define the question           | Versioned route key: chain, contracts, code/proxy identity, asset/decimals, holder-selection rule, call path, fixed `q`, horizon grid, and assay family.                                                                                                                                                                                   | Asset path and deployed code are verified; the holder can attempt the exact `q` assay. Keep screen failures.                                                                                                                                                                                                                    |
| 2. Measure the current state     | Block/hash-pinned observation, first local receipt time, freshness, `q`-specific holder execution or quote, and separately labeled aggregate capacity proxies.                                                                                                                                                                             | Source identity and freshness pass. A proxy cannot be promoted to holder ability.                                                                                                                                                                                                                                               |
| 3. Capture flow and maximum flow | Complete event intervals including quiet ranges, gross deposits, gross withdrawals, signed net flow, interval max at declared resolutions, and attribution to the relevant vault or route.                                                                                                                                                 | Receipts reconcile to endpoint state under a stated accounting identity; missing ranges remain missing. A maximum is historical, never a withdrawal guarantee.                                                                                                                                                                  |
| 4. Define the future target      | Versioned route-specific endpoint: Aave reserve cash can ask for first sampled below-`q` cash by `H`; a holder route may ask for an exact-target probe in a declared tolerance window. Recovery/condition duration is a separate episode target. Specify allowed lag, pauses, changed code, holder attrition, missing data, and censoring. | Boundary and censor rules are frozen before outcomes. A first observation after `H` does not count as a by-`H` event; an exact-target assay cannot be replaced by a convenient later sample.                                                                                                                                    |
| 5. Issue and score prospectively | Immutable issue with local feature-completion time, finalized B/hash, source SHA, target and due time. Score once from a sealed source cutoff. Retain missing, pending, quiet, improvement, deterioration and ambiguous states.                                                                                                            | No reconstructed past issue, late source, moving cutoff, or rescore can create apparent lead.                                                                                                                                                                                                                                   |
| 6. Evaluate                      | Compare a route-specific candidate with simple baselines, chronological holdout, horizon embargo, nonoverlap sensitivity and independent event/control clusters. Report abstention, censoring, false notices per venue-week and actual sampled lead.                                                                                       | The predeclared assay-specific gates in the [prospective protocol](venue-capacity-prospective-v2.md#prospective-clock-controls-and-scoring) pass on an untouched holdout. Otherwise calibrated forecast and predictive-alert fields stay unavailable; labeled conditional projections and historical backtests remain eligible. |
| 7. Publish claims                | Current fixed-q ability, its source/freshness, observed shrinking ability, a labeled conditional forecast for user-selected `H`, historical backtest results, and separately calibrated forecast or duration claims when their evaluation gates pass.                                                                                      | Each sentence identifies the measured object and clock. Alerts require a material change, actionable lead and independently validated false-notice burden.                                                                                                                                                                      |

Conditional historical/mechanical projections do not wait for prospective validation or a mined payout. A historical holder backtest may validate performance against hash-pinned exact-holder simulations, retaining native Q, route, holder, source integrity, simulation status, censoring and chronological split. That validation is distinct from mined delivery and prospective calibration. Staged full-route simulation eligibility requires independently agreed final-asset execution, every required leg, verified units and state continuity through conversions; first-leg calls, getters and public conversion quotes remain partial evidence. The legacy mined-receipt eligibility gate remains separate.

Factual protocol/news notices identify proposal, queue, execution, pause or parameter change with source and first-known clock. A labeled scenario may estimate what happens if an attested parameter change executes, or under an explicitly stated event assumption. Assumed impacts are not causal estimates or calibrated probabilities; causal/predictive claims and alerts retain their outcome and false-notice gates.

## Common evidence envelope, route-specific adapters

Implement a small shared envelope around route adapters. Do not normalize unlike endpoint values into a universal `capacityUsd`:

```ts
type ExitQuestion = {
  routeVersion: string
  assayVersion: string // reserve cash | direct withdrawal | vault redemption | swap route
  asset: string
  subject:
    | { kind: 'reserve'; marketId: string }
    | { kind: 'holder'; selectionVersion: string; holderId: string }
  amountRaw: string
  horizonSeconds: number
  targetProtocolVersion: string // route-defined first loss, exact-target probe, recovery, etc.
}

type SourceRef = {
  role: string // anchor, holder probe, route quote, flow window, code identity, etc.
  block: number | null
  blockHash: string | null
  physicalSha256: string
  firstLocallyAvailableAt: string
}

type EvidenceEnvelope = {
  question: ExitQuestion
  sources: SourceRef[]
  issuedAt: string
  targetAt: string
  fixedSourceCutoffAt: string
  coverageChecks: {
    name: string
    status: 'complete' | 'partial' | 'unverified'
    reason: string | null
  }[]
  valuationAssumption: string | null
  outcome: 'observed' | 'censored' | 'pending' | 'missing'
  claimLevel:
    | 'current_observation'
    | 'historical_pattern'
    | 'conditional_projection'
    | 'validated_forecast'
  reason: string | null
}
```

The route adapter owns the exact on-chain calls, holder eligibility, token units, valuation, flow reconciliation, target assay and failure reasons. The shared layer owns evidence identity, typed source receipts, clocks, as-of enforcement, named coverage checks, censor accounting, split bookkeeping and claim gating. A source list is necessary: one scrvUSD issue can bind a holder probe, route quote and flow windows, whereas an Aave reserve-cash issue binds an aggregate anchor and preceding path. Store **gross and net** flow separately: `net = deposits − withdrawals` can hide simultaneous large inflow and outflow. Keep “maximum observed flow over a complete interval” separate from “maximum executable exit for this holder at this block.” A net-cash projection already includes observed replenishment and depletion: subtract user Q once, and do not subtract competing flow again. An explicit gross-flow scenario instead starts from current cash, adds replenishment and subtracts gross depletion once; state estimates, assumptions and missing flow coverage.

Forecast questions need route-specific target protocols. At least three families already occur:

- **Loss by `H`:** among valid issued decisions, did the first sampled fixed-q impairment occur at or before `H`? An observation in `(H, H + allowed lag]` can close the sampled path but is after the target horizon.
- **Exact-target ability:** did the same holder's fixed-q route assay succeed inside the predeclared target-time tolerance? A later success does not substitute for the target observation; first-loss timing is a separate interval-censored label.
- **Duration after loss:** starting from a witnessed impaired state, what fraction of complete, independent episodes recovered by each later horizon? Left/right censor and unresolved crossing brackets remain visible. The answer may be a range or “unavailable”; an observed run length alone is not a likely future duration.

For any estimate, report the eligible denominator, scored denominator, independent episode count, censor/pending count, source period and uncertainty. A model interval uses only the training prefix; holdout outcomes never set a threshold. If support or calibration is inadequate, retain clearly labeled conditional point/range estimates with their assumptions and backtest errors; withhold calibrated probability and supported duration claims. Distinguish claim eligibility from request-to-payment delay, observed recovery brackets from hypothetical duration, and completed episodes from censored/open episodes. Unknown queue service or pause release has no guaranteed end.

At Step 5, each route adapter must derive a required observation window for
**each issued forecast**. The shared audit joins that window to its source
receipts and replays the frozen score from stored rows restricted to its as-of
cutoff. That replay cannot prove upstream source completeness. A successful
audit of one issue can only claim completeness for that issue; a schedule-wide
claim requires the same coverage and replay checks for every issued cell.
Equal-time row ordering, late source availability and missing intervals remain
explicit abstention or censor reasons.

## Current mapping and next build order

| Route                       | Available now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Missing before calibrated forecast or duration claims                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aave sampled reserve cash   | Frozen eight-reserve history, strict by-`H` label and trend sensitivity; pure prospective USDe first-breach issue/scorer; [v2 issue schedule](aave-usde-first-breach-schedule.md), [offline hourly coverage audit](aave-usde-first-breach-coverage.md), [dormant additive recorder DDL](aave-usde-first-breach-recorder-ledger.md), a [dormant single-slot runner](aave-usde-v2-slot-runner.md), [dormant v2 issue/score DDL](aave-usde-v2-issue-score-ledger.md), and a [read-only v2 database ledger audit](aave-usde-v2-ledger-audit.md). | PostgreSQL migration integration, distinct audited reader and recorder roles, USDe cutover and UTC scheduling, real durable recorder receipts, independent physical preregistration, complete USDe feed, live insert-once issue/score receipts, local-clock proof, same-holder fixed-q withdrawal outcomes, independent event/control support. Historical grid excludes USDe. |
| scrvUSD vault / Curve route | Historical event-flow summaries, witnessed direct-holder first-loss classifier and separate nominal quote evidence.                                                                                                                                                                                                                                                                                                                                                                                                                          | Route-specific endpoint-state reconciliation for event flow, current same-holder executable exit at each decision, complete route/state receipts, independent first-loss/recovery support, sequential exit-path execution evidence for the full route.                                                                                                                        |
| Generic venue page          | Current stamped proxy and fresh witnessed decline; user can choose amount and horizon.                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Per-route assay adapter, complete maximum-flow evidence, validation gates and a duration study. Conditional projections may use verified mechanics and explicit historical/analog assumptions; calibrated fields remain unavailable until their gates pass.                                                                                                                   |

Build the next venue by completing steps 1–3 and a dry, offline verifier first; then freeze one small prospective `q × H` score grid. Bind arbitrary user-entered `q`/`H` to the actual question and label unsupported extrapolation assumptions; do not inherit calibration from a different cell. Historical/mechanical conditional outputs may be published with their evidence limits before prospective scoring. Calibrated claims and predictive alerts require the exact route/assay gates. The recorder registry and generic read/flow modules already provide an observation starting point; the [prospective extension](venue-capacity-prospective-v2.md) provides the assay and scoring gate. Version the shared envelope and adapters after two independent route families satisfy it, so the common fields reflect proven overlap rather than an assumed universal capacity measure.
