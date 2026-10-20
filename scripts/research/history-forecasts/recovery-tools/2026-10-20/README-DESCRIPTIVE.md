# CODEX CONTINUATION: descriptive shallow-neural audit

This source handoff preserves the exact two reviewed evidence-helper files. It does not modify the frozen original 32-file research recipe or the recovery worktree at commit `6aa64254073119c76f2b9e7a713abd601756d872`.

## Runtime and location dependency

`describe_shallow_nn_weaknesses.py` has an explicit absolute `SOURCE` dependency on `/Users/EBmic/research-workspaces/history-forecasts-continuation/scripts/research/history-forecasts`. It imports the original `r16_shallow_nn_independent.py` from that location, requiring the original source and its unchanged helper semantics. The patch is retrievable source, not a claim of portable execution. Do not rewrite paths or evidence identities without reviewing the resulting provenance.

Original evidence lives under `/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence`; the frozen fit scope is `fit-scope-v2.json` (SHA256 `807f6d2a283ac7af9f72a7b3ea2eb251a42414efce09fe16ebd957f56f60ef30`). The scope itself determines the exact merged input pins, canonical keys, output directory, source pins and resource policies. The accepted independent-fit receipt and score-output paths/hashes must be supplied explicitly after they actually exist and have been independently accepted; this source handoff does not attest completion or supply invented result hashes.

## Admission and output

CLI arguments are `--scope`, `--scope-sha256`, `--fit-independent`, `--fit-independent-sha256`, `--score-json`, `--score-json-sha256`, and a fresh `--out`. Here `--score-json` means the exact frozen output directory's `dev-r162-nn.json`, not its `score.json` receipt.

Run only after the original twenty-fit independent acceptance and terminal successful original scoring. Admission verifies matching complete receipts, score-monitor success and budgets, score-output pin/path/schema, all original independent evidence pins unchanged, clean preserved fit/score/post-score audit ledgers, original source pins, merged pins and original all-five daily coverage. Successful original scoring preserves `audit.json`; no changed independent pin is exempted.

The original pooled global median timestamp and salted series groups define all four retrospective hash-half/time-half cells. Output retains all five models and twelve horizon/barrier labels, yielding 240 slices, including zero support. Metrics are Brier model/reference/difference, observed and predicted means, calibration ratios, probability deviations from fH, and exact/within-1e-6 agreement. Ratios mean predicted mean divided by observed rate; zero-event ratios are null. No clipping or rounding precedes probability comparisons.

These are descriptive seen-development diagnostics only. They perform no fits, new labels, reserve access, model selection, eligibility tests, rankings, p-values or causal inference. Early-time cells train on future peer-series data. The helper does not independently verify Torch training, stopping, RNG, gradients or weights.

## Resources and tests

Arrays are processed sequentially by horizon and model. The conservative owned-array estimate below 512 MB is a design estimate, not measured or enforced RSS. Run under the parent's 2.5 GB process cap and retain actual external monitor telemetry separately; this patch contains no actual-run resource claim.

Nine synthetic tests cover known arithmetic, zero-event/empty support, probability precision, missing/invalid values, pooled split boundaries, non-daily exclusion, digest mutation, incomplete/mismatched admission, score-path mismatch, successful score admission, changed score output and resource refusal. They do not read real predictions. Example on the original host:

```sh
PYTHONDONTWRITEBYTECODE=1 /Users/EBmic/research-workspaces/history-forecasts-recovery-runtime/bin/python test_describe_shallow_nn_weaknesses.py -v
```
