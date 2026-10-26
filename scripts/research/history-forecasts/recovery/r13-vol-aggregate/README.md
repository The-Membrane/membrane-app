# Archived R13 volatility aggregates — CODEX CONTINUATION

This source handoff preserves the exact reviewed helper/tests/admitted request and executed parent monitor/independent validator. Applying it does not aggregate data. It contains no recovered metric/result payload, raw manifest, row predictions, outcomes or NPZ arrays.

Fixed scope: all five source-declared horizons(1h,3h,12h,1d,3d), all pooled/B12/B13a cohorts, both fHQ(lsQ)/fHW(lsW) versus fH:30 comparisons. The target is squared natural-log error against the original annualized future realized-volatility proxy, computed from future close-to-close return RMS with original missingness rules. It is not QLIKE, latent-volatility calibration, a price band, touch skill or a fresh test.

Exported fields are named volatility mean/median losses, rows/weeks, recomputed mean-loss differences, candidate/reference mean-loss ratios and fractional reductions. Zero reference ratios remain null. Pooled row counts/weighted mean losses reconcile with the two cohort summaries; medians remain separate and cannot be pooled from medians. All archived SE/p/weeks-to-power fields retain an explicit legacy_descriptive_UNVALIDATED label. No new significance or power gate follows.

The original source vol_power export has no >9 tail-error shares; an unrecovered r13_devcheck vol_mse schema contains different fields. Neither QLIKE nor fH-vs-EWMA/persistence skill can be inferred from these archived means. Median loss improvement can coexist with worse mean squared log loss; aggregates alone do not identify a rare-error cause.

## Provenance

Original staging is `/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence/`:

- audit_r13_vol_aggregates.py7555bytes SHA256 f2fe1975824a3709011781567736297e914057687770b8ef4ae17a33748029b8;
- test_audit_r13_vol_aggregates.py4392bytes SHA256 9b7ae15b1607f260ad7497f53228d2af8a40b3e103a427e62e10aa7de29fd167;
- admitted request6331bytes SHA256 54c51099e1e671c1caab9e10a2b87ce83449d471768d47a067676ab09fff9920.

Parent proof sources were preserved exactly in durable-r13-vol-parent-verification-v1/: monitor1989bytes SHA256 1ff02d42f1500d7e3a83836b3c87123ac3b60cf106f106c56fbaa64e82c06782; independent verifier2816bytes SHA256 616cddc0d43b51b2da77340f266e92671c3d97c73a46f18ebc5269663f8b1981. The verifier uses60-digit Decimal arithmetic, checks all30 projections/legacy fields, all ten weighted pooled pairs and final eleven pins, without importing the helper.

Parent/fresh-refuter synthetic suites passed six tests each. Accepted child39707 exited0 in0.11390475seconds with37158912B sampled peak RSS,6420189184B minimum free disk,stderr0 and eleven unchanged admission/request pins. Samples are not continuous peak measurements.

The request binds original producer/source identities, recovery/sidecar provenance, runtime proof and absolute local evidence/output paths. These dependencies remain explicit; this patch does not claim blanket portable execution. Source byte identity and arithmetic preservation do not establish origin availability, split integrity or strict-forward validity. No metric pipeline is rerun during this source packaging.

User objective is EVENT FIRST: P(relevant liquidation line hit byH). Direct event models, time-to-hit models and component forecasts plus mechanics are alternative routes; price forecasting is one route rather than a mandatory intermediate. Standalone volatility/distribution-feature products remain useful when directly validated for their own target. No new fitting, reserve reassignment, revised eligibility, promotion, LP correction or NOT RUN change follows. Two-unseen-set-before-development constraints remain; existing O14 and contamination qualifications remain.
