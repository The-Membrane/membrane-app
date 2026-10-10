# H24 aggregate-cash candidate sweep

**Status:** offline historical research; no production model change  
**Study:** `carry-h24-subject-local-candidate-sweep-v1`  
**Runner:** [`scripts/research/carry-cash-candidate-sweep.mjs`](../../scripts/research/carry-cash-candidate-sweep.mjs)

## Question

Can a small, fixed-before-holdout family of simple subject-local models qualify any of the eight exact payout-asset subjects that currently abstain with `model_selection_failed`, including supplemental Aave V3 USDe?

The answer for this v1 family is **no**. None of the eight subjects reached the existing 80% interval-coverage floor on the ten-row selection partition. A deterministic diagnostic candidate was locked for each subject before opening the final ten rows, but a holdout result cannot repair a failed selection gate. No production forecast should be enabled.

## Sealed chronology

Each subject keeps its own 60 disjoint H24 pairs. There is no pooling across routes, destinations, or assets.

```text
20 fit → 20 calibration → 10 selection → 10 untouched holdout
            parameters          choose one       score only that one
```

Every source and target is tied to the exact route, destination, payout asset, decimals, finalized block time, and verified local receipt chain. A pair source must be strictly later than the prior pair target. The same strict embargo is checked at every partition boundary.

V1 is pinned to exactly 120 daily receipts per cohort. Later ledger appends coexist but never enter or repartition v1; a missing or changed pinned receipt fails closed. The SHA-256 covers the JSON ordered list of `{anchorAt,receiptSha256}` objects. The policy and implementation contract digest is `1ea1e24b4ed33c46fc51ff1b002787bfe7fce59eb55ede9a6a76f3134b438ae4`.

The golden v1 replay is the SHA-256 of `JSON.stringify(runCurrentCashCandidateSweep())`: `3eb9f5b14d0914f542d6055b4473c2b5b08954c8d27551abad4eab39f3153256`. It pins the complete reported result alongside the input and contract digests, so any changed behavior or report requires explicit review.

| Cohort       | Manifest SHA-256                                                   | Anchors               | First / last receipt SHA-256                                                                                                            | Ordered-list SHA-256                                               |
| ------------ | ------------------------------------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Frozen       | `9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3` | 2026-06-06…2026-10-03 | `4ea4c9fc93698142078d36d332c47c9a04bfd5dbbb6f6e8e1d415e26d6465587` / `a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2` | `53c02c40234934b2e4c8631596dddc15e7c20a340a8ce29321dfaabc2854e981` |
| Supplemental | `11647d6e15a5f6d18d96d016e5522b1dcbf452b45022992dd139c2fa9a0d6ede` | 2026-06-07…2026-10-04 | `2ec2449bfaeef01341dc856cb51f24ae2db0f01ef42ec56d626e76f66b74795a` / `368163df8a8b7b518caee9fe049f7664f4ef09d0e860c1333ec354e4f219cf2e` | `48067c00411bd0f6a07b014230b54ec29065ff5a58b57e1ef8601be0a7120180` |

## Candidate family

Point rules are persistence, last-change persistence, lower-median raw delta over fit-20/recent-10/recent-5, and lower-median source-relative return over the same windows. Each point rule is paired with:

- a signed empirical calibration-residual p05–p95 band; and
- a finite-sample 80% split-conformal absolute-residual band.

Only fit data sets point parameters. Only calibration data sets interval parameters. A learned candidate must cover at least 8 of 10 selection outcomes and have strictly lower selection MAE than raw-cash persistence. Persistence itself must meet the same interval floor. If several candidates qualify, the fixed rule chooses the lowest point MAE, then the narrowest mean interval, then candidate ID. If none qualifies, the diagnostic lock uses highest selection coverage, point skill, MAE, interval width, and candidate ID in that fixed order. The diagnostic lock remains ineligible regardless of its later holdout score.

After that choice, and only after it, the untouched holdout is scored. A learned candidate must again cover at least 8 of 10 outcomes and beat persistence MAE. A persistence candidate must meet the interval floor. All counts preserve the existing 20/20/10/10 minimums.

## Current result

The verified 68-subject public corpus contains 63 subjects with exact payout identity and 60 disjoint H24 pairs. The candidate sweep narrows those to the eight subjects whose existing learned and persistence models both fail selection.

| Exact subject                | Locked selection coverage | Holdout coverage | Holdout MAE numerator, model / persistence (÷10)            |
| ---------------------------- | ------------------------: | ---------------: | ----------------------------------------------------------- |
| AUSD VaultV2 `0x3240…f02f0c` |                      6/10 |             6/10 | `528379911101 / 528379911101`                               |
| GHO sGHO `0xe175…ca1d`       |                      6/10 |            10/10 | `9011590512904301282706161 / 9646694259612524465408511`     |
| USDC Aave V3 `0x98c2…e16f5c` |                      7/10 |            10/10 | `21557605597303 / 21627279830979`                           |
| USDC VaultV2 `0x0696…1556f0` |                      6/10 |             9/10 | `21292107 / 21319210`                                       |
| USDC VaultV2 `0x153b…64a57`  |                      7/10 |             7/10 | `213699700 / 213699700`                                     |
| USDC VaultV2 `0xd5cc…eaa13`  |                      4/10 |             7/10 | `248932593550 / 248932593550`                               |
| USDC VaultV2 `0xf1ca…76f9a1` |                      7/10 |             4/10 | `18814128 / 18814128`                                       |
| USDe Aave V3 `0x4f59…12decf` |                      7/10 |             8/10 | `142501698549953354026805636 / 112827511837594538669818824` |

Supplemental Aave V3 USDe shows selection-stage point-skill evidence: fourteen candidate point/band combinations have lower selection MAE than persistence. Its locked candidate still covers only 7 of 10 selection outcomes. On the untouched rows it covers 8 of 10, but its point MAE is worse than persistence. It therefore fails both the prior selection gate and the untouched point-skill gate and remains unavailable.

## Interpretation

All exposed rows, including the former holdout, are development data now. This is an exploratory selection-stage sweep: the known selection failures motivated the candidate family, but the final holdout was not used to build or choose it. Recent robust deltas and source-relative returns do not repair the interval instability in the current failed subjects. Expanding or widening the family after reading these selection results would add researcher degrees of freedom. A future v2 family must be declared before evaluation and requires fresh, nonoverlapping chronological outcomes.

The study concerns aggregate underlying cash. It does not measure a holder's executable exit, competing claims, probability of exit, restriction duration, or prospective alert performance.

Run the deterministic replay with:

```bash
node --import tsx scripts/research/carry-cash-candidate-sweep.mjs
```
