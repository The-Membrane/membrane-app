# R16.4 daily calibration clock review — CODEX CONTINUATION

Date: 2026-10-23. Scientific source: `446e13f`. Shared result: membrane-board O193 FINISH. Owner authority: O193 START, commit `d5fff08`.

## Result and interpretation

Updating the existing weighted calibration rule daily improved its aggregate interval score on both spent-development primary cells. The comparison changed only when calibration labels became usable. Original point forecasts stayed fixed. These are uncertainty bands around **touch probabilities**, checked against grouped observed touch frequencies. They are not price bands.

| Primary cell | BLOCK score → DAILY score (pp) | Relative score change | Group coverage | Median row width (pp) |
|---|---:|---:|---:|---:|
| H24, level k5 | 9.685681117 → 9.380811964 | −3.1476274% | 97.54098% → 97.26776% | 4.446126 → 4.277638 |
| H72, level k7 | 14.631350846 → 12.986337790 | −11.2430703% | 87.81163% → 88.64266% | 5.191980 → 5.187115 |

Lower interval score is better. The primary supports were unchanged: 114,762 H24 rows and 114,709 H72 rows. DAILY supplied every required primary endpoint. The original BLOCK reconstruction had zero maximum endpoint error on these saved inputs.

The mechanisms differ by horizon. H24's mean group width fell from 9.403398 to 9.021287 pp. Its upper-miss penalty increased from 0.282284 to 0.359525 pp, with one more uncovered upper group. Its total improvement therefore reflects narrower bands despite worse upper misses. H72's upper-miss penalty fell from 3.383336 to 2.042095 pp and explains most of that horizon's improvement. Lower-miss penalty and mean group width also declined.

## Weaknesses remain visible

H24 SG1's interval score worsened by about 0.06427 pp. Every H24 SG remained above 95% group coverage. H72 SG4 coverage remained 80%. The SG1/block 3 view worsened by 4.33847 pp at H24 and 7.50433 pp at H72. Block 3 spans 2019-07-01 through 2019-12-29. These are genuine descriptive weaknesses, not independent trials.

Across comparable blocks, improved/worse score counts were 11/4 for H24 and 12/3 for H72. Across comparable SG-by-block views, they were 60/14 and 51/23. Aggregate improvement does not erase those weaker views.

The coverage resolution check answers a separate instrument question. Each comparable SG-by-block view has at most five evaluated probability groups. Coverage therefore lies on a coarse rational grid. No such grid can attain the registered 85–95% coverage box. Zero box passes at this resolution are not evidence of model weakness. The box and all original gates remain unchanged; this arithmetic result does not excuse actual misses or weak interval scores.

## What was held fixed

The accepted native cohorts, point forecasts, 182-day blocks, SG exclusions, weighting, interpolation, clipping and denominator floor stayed fixed. Each held SG/block retained its sealed past-probability fold edges. Those same edges rebinned every training probability. A row's saved own-fold bin was not used as its training-pool bin.

BLOCK used only other-SG labels satisfying `day + horizon_days < block_start`. DAILY used only other-SG labels satisfying `day + horizon_days < issuance_day`. Folds without original edges stayed unavailable. The primary population remained original `clock_target & F_eligible`; a missing DAILY endpoint would have refused the primary comparison rather than shrink its support.

Original implementation: [daily clock core](../../scripts/research/history-forecasts/r164-daily-clock/q26-daily-clock-core.py), [source qualification tests](../../scripts/research/history-forecasts/r164-daily-clock/test_daily_clock.py), and [original prospective protocol](../../scripts/research/history-forecasts/r164-daily-clock/prospective.md). The private executed request and orchestration sources are preserved verbatim in the [source capsule](evidence/O193_DAILY_CLOCK_SOURCES_CODEX_2026_10_23.json). Its original DRAFT records the earlier hold; the later owner receipt authorizes only the completed comparison.

## Verification and limits

The parent and an independent saved-output checker recomputed 198 views with 10,720 assertions. Their accepted audit JSON has SHA256 `7a5edd45ec020b37177295c3f84bf7e6f0f2ffecadb22d8eba9f24608ea38522`. This verifies saved input/output reduction and joins. It does not independently reconstruct raw hourly labels, full issuance timestamps or original point forecasts.

The single execution finished in 45.7775 seconds. The OS-observed maximum child RSS was 139,198,464 bytes. The child was reaped, its process group was absent and source/runtime pins stayed unchanged. RSS was observed and checked after execution, not continuously contained. No point-model fit or numerical retry occurred.

This is one descriptive comparison on already-spent development data. The explicit owner exception is consumed. It establishes no inferential significance, unseen win, individual latent-probability coverage, product calibration or model promotion. Day-resolution maturity checks are not full-hour clock proof. All blind-test and promotion holds remain operative. The 67 previously accepted scientific sources are unchanged; this review and its capsule add documentation only.

## Next proper step

The daily clock is now an evidenced development result, with clear horizon and subgroup weaknesses. Preserve those observations and the original rule. Before further revision development, reserve the required unseen sets or obtain a separate explicit owner decision. Any future comparison needs a prospective claim, fixed support and retained weakness views. This capsule grants no permission to rerun or tune.
