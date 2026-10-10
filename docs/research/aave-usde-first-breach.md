# Aave USDe first sampled cash breach by horizon (offline v2)

This is a **separate research question** from the endpoint cash study (`aave-v3-usde-prospective-sampled-cash-v1`). For a fixed amount `q` and horizon `H`, it asks whether an eligible, first locally observed Aave V3 USDe aToken underlying-balance sample fell **strictly below `q` at least once after issue and by `issuedAt + H`**. A sampled balance is a reserve-cash proxy under a $1 USDe assumption. It is not an executable holder exit quote or a guarantee that a withdrawal succeeds.

Implementation: [`scripts/research/aave-usde-first-breach.mjs`](../../scripts/research/aave-usde-first-breach.mjs). It is pure and performs no RPC, database writes, or alert delivery. Its study identifier and SHA-256 receipts differ from v1. The v2 issue records the sealed v1 source-eligibility issue SHA as provenance, without writing or rescoring the v1 issue. v1's verified observed-source normalization supplies the pinned finalized block, Aave reserve identity, raw balance, $1 assumption, local observation and creation clocks, fresh anchor, and issue-time as-of rules. A backfilled row is never prospective.

## Issue contract

- `q` must be positive and finite. `H` must be an integer number of seconds from **8 hours through 30 days**. The anchor cash must be **at or above `q`**; a pre-existing shortage is not a new breach warning.
- The issued anchor must be the latest eligible first locally observed row at issue time, no more than 10 minutes old. The underlying finalized block and source identity must pass the v1 observed-source checks. The issue and its pre-issue source path are sealed before future observations.
- The nine fixed scored cells are `q ∈ {$1m, $10m, $50m}` × `H ∈ {8h, 24h, 7d}`. Other valid cells are sealed as descriptive only and cannot enter the fixed-grid score.
- The horizon starts at **issue time**, including any nonzero anchor age, not at the anchor block or local observation time.

## Score contract

The score can become final only at or after `H + 8h + 120s`: the target witness observation window ends at `H + 8h`, and the v1 source permits creation up to 120 seconds after local observation. Before that fixed availability cutoff the result is `pending`. The caller must supply an explicit existing-score lookup result and persist each final score **insert-once keyed by the v2 issue SHA**. A later run must refuse rescoring. The persistence layer is not implemented here.

The input must be the complete, ordered recorder feed for the issue's reserve through the fixed source cutoff. **This pure scorer cannot verify feed completeness or authenticate the caller.** It marks `sourceCompleteness: caller_unverified` and `prospectiveEligible: false`; even an `observed` negative is not a public assurance of no breach. The scorer considers only rows first locally observed by `targetAt + 8h` and created by `targetAt + 8h + 120s`, regardless of when a later score call runs. Every considered row from the anchor to the first target witness is normalized and linked by strictly increasing local observation time, block number, and block time, with distinct IDs and block hashes. Any gap **over 8 hours**, ineligible or identity-drifted row, duplicate/nonmonotone row, or missing target witness within 8 hours yields `censored`, including when an earlier breach was seen. A censored early breach is **not** credited as a completed by-H outcome.

The final receipt seals the full inspected source path, a separate path SHA, the first below-`q` sample **at or before H**, the first subsequent recovery sample if seen before the target witness, and the first witness at or after H. It reports these distinct facts:

| Field                      | Meaning                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `breachedByH`              | An eligible sample after issue and at or before H was below `q` at least once. A later recovery does not erase it. |
| `targetWitnessBelowAmount` | The first eligible sample at or after H was below `q`. It may be observed up to 8 hours after H.                   |
| `exactHTargetBelowAmount`  | Below-`q` state **only when a sample was observed exactly at H**; otherwise `null`.                                |
| `firstBreachOnlyAfterH`    | The first target witness was below `q` after H, but there was no sampled breach by H.                              |

These are observed sample labels, not continuous-path truth. An unobserved dip and recovery between samples is undetectable. A below-`q` target witness after H must never be relabeled as a breach by H. The score receipt records actual `scoredAt` and the **fixed** `sourceAsOf`; running the scorer later against the same complete source cannot change the label or path. The receipt SHA includes `scoredAt`, so two calls at different times have different receipt hashes even when their labels and source paths agree. Durable insert-once persistence must select the first final receipt.

## Integration gates

Before using this for any public forecast or alert, an independent operator must supply a complete, append-only, authenticated first-observation feed, issue and score jobs with durable insert-once stores, outage and missingness accounting, a prospective holdout with fixed denominators, and calibrated outcome reporting for every fixed cell. The current module provides none of those operational guarantees by itself. This study does not produce a likely duration, calibrated probability, holder exit assertion, or notification. Local synthetic tests exercise breach/recovery, exact-H and after-H separation, source censorship, score closure, as-of filtering, and immutable issue linkage.
