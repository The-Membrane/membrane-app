# Codex continuation: R16 shallow temporal admission census

Origin: Claude Code session session_01Vv8BNqd3QymKqE3KbgGfYF.
This is separately labeled Codex continuation source, not original Claude output.

Source-only handoff: unchanged reviewed helper, synthetic tests, and this README.
No frozen request, canonical series metadata, result, raw input, predictions or per-row
arrays are included. The local frozen request binds private accepted merged NPZ inputs,
parent merge admission, canonical series order, original sources and runtime proof.
Relocation requires separately reviewed bindings; this source alone admits no data run.

The census reconstructs shallow tier_rows metadata concatenation T1,T3,T12, pooled
median timestamp, original hashed groups/group%2, daily test origins, original eligible
training masks and minimum eligible validation-group identity. Counts precede original
sampling/caps. Duplicate horizon-row exposures are intentionally retained, not reported
as independent market episodes. Each original test cell gets cutoff C=min(test origin);
strict peer support requires ts+12h<=C. Original validation-group identity is preserved.
Unsupported cells remain explicit. A different minimum strict eligible group is diagnostic
only and never silently replaces validation. Own-horizon ts+T and conservative Tmax ts+12h
availability summaries are separately labeled arithmetic proxies.

Only sid and ts NPZ members are decompressed. Whole NPZ bytes are streamed for pinned
integrity; this does not inspect outcomes. No y, fH, predictions, features, RNG, model
fitting or bootstrap is used. No timing-effect estimate, strict-forward validation,
causal conclusion, old per-fit pairing recovery, candidate/gate change or promotion is
implied. Counts alone do not establish adequate training sample sizes or feature causality.

Exact original source pins:
 r16_nn.py 637915e982b961029dcd5b3b69dc6903564f2482fbfd604d2330c88e1cf68f20
 r16_dev.py 702cedb98c7cfcfe77985c5f75073ec2a6f09a9a3e9dd97747328e42018ae29f
Only the original groups_of AST function is compiled into a NumPy/hashlib namespace;
forecast modules and Torch are never imported. Synthetic tests refer to explicit original
source paths under /Users/EBmic/research-workspaces/history-forecasts-continuation.
The helper has no syscall-level filesystem guard; its declared loading function enforces
the NPZ member allowlist. External parent monitoring uses 1 GB sampled RSS, 2 GB free-disk
reserve, 300 s wall and 5 MB aggregate output with child-process cleanup.

Validation before execution: author 12 synthetic tests PASS; parent independently read
actual code/tests/request and ran 12 tests PASS0.067s; separate fresh refuter12PASS with
no blocker. Tests include exact tiny original masks, duplicate-weighted median, daily
filter, inclusive12h, differing strict minimum group without replacement, empty support,
identity failures, tracked member allowlist and complete IPC with forbidden object-valued
y/fH arrays that would fail if loaded. This package does not claim a historical result.

Intake in a disposable checkout:
 git apply --check /absolute/path/q26-r16-temporal-source.patch
 git apply /absolute/path/q26-r16-temporal-source.patch
Compare both Python files' exact SHA256 and byte sizes with sender's frozen pins.
Synthetic tests only (the pinned original source paths must exist):
 cd scripts/research/history-forecasts/recovery-tools/2026-10-20/r16-temporal-admission
 /path/to/accepted/python -m unittest -q test_audit_r16_temporal_admission
