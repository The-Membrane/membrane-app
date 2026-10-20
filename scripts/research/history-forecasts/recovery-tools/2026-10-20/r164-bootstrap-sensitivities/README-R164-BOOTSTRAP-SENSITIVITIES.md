# Codex continuation: stored-input R16.4 bootstrap sensitivities

Origin: Claude Code session `session_01Vv8BNqd3QymKqE3KbgGfYF`.
This is separately labeled Codex continuation source, not original Claude output.

This source-only handoff includes the unchanged reviewed helper and its synthetic tests.
It exports no loss matrices, predictions, per-series input manifest, per-replicate arrays,
full results or private frozen request. Local accepted request bindings remain in the
research evidence workspace. The parent is independently checking completed descriptive
results; this source package does not assert that validation is finished.

The helper retains all 16 groups x 12 comparisons x 3 modes = 576 statistics, including
undefined cases. Its fresh common-draw design uses 2,000 replicates and independent
SeedSequence([20261641, group ordinal]) streams, drawing series weights before block
weights. Identical weights are reused across comparisons and modes within each group.
Ratios retain unequal observation counts. Zero-denominator replicates are censored,
never redrawn or filled; their remaining statistics are conditional on valid denominators.

CGM row/calendar/intersection terms are variance-formula terms, not identified additive
variance components. Bootstrap variance differences do not establish a time-only ceiling.
MdLo/MdHi supply point-mean envelopes only, conditional on UNPROVED ordinary nearest
float32-to-float16 packing; joint configurations may be unattainable. They are neither
SD bounds nor recovery of lost original float32 values. This is not original global-RNG
replay, a new forecast, power calculation, p-value correction, selection or gate change.

Portability: ORIGINAL is an explicit local source path; the frozen request binds exact
Python/NumPy runtime, helper/tests, scorer, runtime proof, accepted matrix reconstruction,
parent acceptance and its successful monitor. Relocation requires fresh reviewed bindings;
copying this source alone does not authorize a data run. The helper's request admission
must be parent_accepted. The preserved draft refuses before matrix metadata or RNG.
The original r164_score.py source pin is
151b6eb0c3f8543fe6b4e11c560407eacac3ce4780ce7068f9609c5e86055142.
Only its cells/twoway_mean AST functions are used by synthetic parity tests.

Validation: author 12 synthetic tests passed; parent independently ran 12 tests and a
separate fresh refuter ran 12 tests with no blocker. The suite covers unequal-cell ratios,
common-draw original-function parity, balanced additive arithmetic, zero denominators,
zero SD, negative CGM, 576-record closure/serialization and identity refusal/failure receipts.
The helper has no syscall-level filesystem guard; its code accesses declared evidence
paths. External parent monitoring enforces 1 GB sampled RSS, 2 GB disk reserve, 300 s wall
and 5 MB output. No Torch dependency or forecast-module import is introduced.

Review/apply in a disposable checkout:
  git apply --check /absolute/path/q26-r164-bootstrap-source.patch
  git apply /absolute/path/q26-r164-bootstrap-source.patch
Compare SHA256 and byte sizes of the two Python files with the sender's frozen pins.
Run only synthetic tests during source intake:
  cd scripts/research/history-forecasts/recovery-tools/2026-10-20/r164-bootstrap-sensitivities
  /path/to/accepted/python -m unittest -q test_audit_r164_bootstrap_sensitivities
The original pinned scorer path must exist for that one synthetic parity test.
