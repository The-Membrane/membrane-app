# Independent source refutation — CLEAR, synthetic/source scope only

Reviewed exact `/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence/r17-conditional-cdf-comparison-v1/cdf_comparison.py`, 18,985 bytes, SHA256 `f5cae4471db94e1a5e3b187db1c90192aad70f4fa2758fcb98df95ed6b08c7f1`. Tests: SHA256 `b4ff0b7bb0e54aab057fe6e79f0b7a24d89daefc54314cd393d888dcc776f470`. No concrete execution blocker found in this reviewed source. This is not execution admission or scientific-result acceptance.

## Independent mathematical checks actually executed

Imported definitions only, with bytecode disabled and one-thread environment. Compared actual `predict_fold` with the independently written Fraction oracle `/private/tmp/q26-cdf-independent-oracle.py` (SHA256 `c7ab08e6aebe85a9e9933db660d2a9d4c7a3436e4a3c2f63fe9e4ef4b96a004c`). The oracle imports no subject and uses exact rational CDF/median arithmetic.

**330 actual prediction values match exactly:** ten scale-null queries × two states × three arms × five repeated query columns, plus the equal-MAD shape alternative. Both bridge/conditional fallback masks remain false on these supported fixtures.

| Exact fixture | State | A | B | C |
|---|---:|---:|---:|---:|
| Scale null, query −3/2, counts5/15, M=1 and2 | 0 | 11/20 | 2/5 | 2/5 |
| Same null | 1 | 11/20 | 3/5 | 3/5 |
| Equal-MAD genuine shape, query−6, both M=3/2 | 0 | 1/8 | 1/8 | 0 |
| Same alternative | 1 | 1/8 | 1/8 | 1/4 |

The null normalized discrete distributions are exactly identical despite unequal state counts, establishing B=C for every query in that fixture, not merely the printed grid. Ties are inclusive; positive and zero depths remain observations. Missing-state/zero-median fold fallback, unknown-test-state fallback and exact SHA first-byte/low-bit rule were also checked on the earlier source and retained by the final unchanged mathematics. On the exact final source, independently reran all13 synthetic tests: **PASS,0.092seconds**. No admitted NPZ arrays, actual market fits or real-data CLI were executed.

## Load-bearing source review

- **Correct nested mathematics:** lines13–16 use inclusive empirical CDF;26–35 require both training states, finite positive median|Z|, and finite rowwise W before pooling. Lines43–46 query pooled W at the current state's scaled threshold; C uses the own-state original-Z ECDF, preserving algebraic cancellation without introducing transformed-tie roundoff. Lines47/51 expose B transformed ties/distinct-value collapses rather than hiding them.
- **Conservative paired support:** lines39–52 keep B=C=A for any unsupported whole library, unknown test state or invalid scaled query, with raw-fH bridge fallback if A/query is unavailable. Lines69/75 return a support mask independent of evaluation labels. Lines94–99 score A/B/C on exactly the same nonfallback rows, pooled and each year; five horizon passes produce15 such views. Full scored support is still retained separately.
- **Time and asset isolation:** lines58–60 reject future-feature quarters and require exact own evaluation-quarter provenance. Lines62–67 build same-SID libraries with complete/available/finite-scale/known-state eligibility and inclusive `ts+H*3600<=Q` maturity. Lines70–72 record overlapping exclusions, membership digest and maximum label end. Synthetic future-label mutation and foreign-SID addition tests preserve earlier predictions.
- **Fixed negative control:** line18 implements exactly UTF-8 `Q26-R17-COND-NEGATIVE-v1:{int(sid)}:{int(ts)}`, first SHA256 digest byte AND1. Line69 reuses the identical main eligible training library for hash B/C; it does not obtain an easier label-support population.
- **Scores and accounting:** lines77–84 cast labels to float before logloss and compute unknown-label paired Brier endpoint bounds. Lines85–92 retain the accepted helper's54 views per horizon (270 total), including empty/unknown groups, all six arms and paired losses. Lines101–114 reconcile raw-fH against original675 calendar/asset/barrier cells with unchanged tolerances. This path has only been exercised on a synthetic reference fixture in my review; actual reconciliation still requires the admitted run and independent output audit.
- **Diagnostics:** lines116–122 use fixed-prediction global-calendar-block sensitivity at primary H24/−10%, with explicit no-CI language. Lines123–128 produce24 omitted-SID aggregate evaluations × pooled/2024/2025 =72, without refitting. Lines130–138 retain60 common-issuance cross-horizon diagnostics; violations are reported, not repaired.
- **Admission/resources:** lines147–153 pin source/tests/design/base request/cuts, verify executed path, and import only the pinned accepted admission helper before its source/runtime/input/cut checks. Lines161–190 refuse DRAFT, demand fresh output, maintain internal120second alarm,1GB sampled RSS,2GiB disk,10MB output checks, partial/failure receipts and atomic final result. This internal guard still requires the parent-owned outer process guard for startup/final-write containment. No current request was promoted or executed by this reviewer.

## Provenance clarification and limits

Do not infer the active legacy LOW-null policy from base `a2_touch` alone. I read the active route: `r12_tail.py:213` instantiates `M3.S3`; `a3_touch.py:280–283` calls `window_min_null_rule`, whose172–186 implementation explicitly tolerates its configured null fraction. This is distinct from future-volatility regression-target tolerance. The kernel itself depends only on admitted complete labels and finite issued scales; no mathematical verdict here depends on a LOW-tolerance assumption. Hourly-versus-daily libraries and current-quarter retrostandardization versus stored own-issued float32 scales remain separate, verified bridge differences (`build_inputs.py:117–124,135–143`; `a6_touch.py:639–654`).

No causal identification, latent truth, future-volatility quality, unspent validation, market winner, calibrated confidence interval or raw-fH replacement is established by synthetic/source checks. The prospective result must preserve both years, every horizon/barrier, fallback counts, nonfallback support and all adverse diagnostics. This review modified only this `/private/tmp` note; source, tests, input arrays, existing evidence and Board were unchanged.
