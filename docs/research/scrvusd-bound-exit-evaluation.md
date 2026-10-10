# Bound scrvUSD exit evaluation (v2)

`scripts/research/scrvusd-bound-exit-evaluation.mjs` reduces only the separate
scheduled v2 label cohort. The public asynchronous entry point,
`readBoundEvaluationWithPgV2`, first calls `readBoundLabelsWithPgV2`, which
rechecks the retained issue and score receipts against the audited PostgreSQL
manifest and attempt ledger. The pure `evaluateBoundLabelsV2` function is for
deterministic reduction and tests; caller-supplied labels do not authenticate
database evidence.

The result distinguishes an issue before its target, an open target capture
window, a matured issue without a score, a scored missing checkpoint, a scored
ambiguous result, a sampled point success or revert, a first-loss interval,
and right censoring. First-loss offsets remain signed from issue time. Only a
post-issue clean success sample gives a positive sampled lower bound; neither
that sample nor the endpoint proves continuous ability. A missing or ambiguous
point is never counted as an exit failure.

Arms at the same anchor or with overlapping capture windows in the fixed vault
form descriptive dependency components. Component count is not an independent
episode count. When horizons are selected, `rows`, score counts, and dependency
components cover only those horizons; `allIssued` alone reports the full input
cohort. Each horizon reports both trajectory evidence classes and target point
statuses, so an ambiguous target remains visible even when an earlier sampled
loss interval exists. V1 manual issues and scores never enter this evaluation.

`asOfUtc` reconstructs a past view from the currently verified ledger. It does
not prove run confirmation or score persistence was visible at that past time.
The output therefore keeps `historicalAvailabilityCertified` and
`chronologicalBacktestEligible` false; probability, likely duration, and alert
remain unavailable. A future chronological backtest needs independent
persistence witnesses and complete prospective outcome follow-up.

## DB-witnessed as-of evaluation

`readWitnessedBoundEvaluationWithPgV2` uses the separate DB-reconciled witnessed label reader. Its pure reducer, `evaluateWitnessedBoundLabelsV2`, requires that witnessed schema and the exact DB four-arm denominator. The output reports all `issued`, `abstained`, `failed`, and `unknown` arms among runs witnessed by the cutoff, apart from the issued exit-risk set. It does not count runs or published slots lacking a run-visibility witness; `scheduledSlotCohortComplete` and chronological backtest eligibility remain false.

The caller must select a horizon H. A scheduled arm enters H's risk set only when its exact target is between `runVisibleAtUtc + H` and five minutes after that point. The five-minute tolerance is fixed in code before reading outcomes. Targets before H or farther after the tolerance abstain; no score interpolation or shortened lead is accepted. Each H reports eligible issued arms, abstentions, observed, missing, ambiguous, pending, and matured unscored counts. A sampled point result is reported separately from a first-loss interval, whose signed bounds are also shown relative to the run witness. Overlapping windows remain dependency groups, with independent episode count null.

Rows retain the conservative minimum publication lead from run witness to target and the age of the earlier baseline sample at that witness. `currentAtDecision` stays unverified. Source capture starts are self-reported; a sampled success does not prove continuous exit ability. Probability, likely duration, and alerts remain unavailable.
