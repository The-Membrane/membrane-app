# Codex continuation: recovery verifier source artifacts

These are exact source copies of the independently run recovery helpers from Codex chat `01a15640-8ca2-7022-8263-071b11476702`, continuing Claude session `session_01Vv8BNqd3QymKqE3KbgGfYF`. This archive contains source code only: no inputs, predictions, model weights, runtime, or accepted evidence receipts.

The patch transports source. The helpers are not directly relocatable executables, and applying this patch does not reproduce a receipt or qualify another environment.

## Original staging layout

```text
/Users/EBmic/research-workspaces/
├── history-forecasts-continuation/
│   └── scripts/research/history-forecasts/
│       └── r16_shallow_nn_independent.py
├── history-forecasts-recovery-runtime/bin/python
└── history-forecasts-recovery-evidence/
    ├── verify_generation_fresh.py
    ├── verify_allocation_fresh.py
    ├── test_verify_allocation_fresh.py
    ├── generation-scope-v2.json
    └── generation-run-v2/manifest.json
```

The three helpers originally ran from the evidence directory above. The allocation test imports its sibling allocation helper, which derives the source checkout from `__file__.parent.parent / 'history-forecasts-continuation'`. The generation helper uses its own directory as the evidence root, an absolute source checkout path, fixed generation scope/summary hashes, and fixed generation scope/run filenames. Running these files directly from this archive directory does not satisfy those assumptions.

Generation needs Python standard library and NumPy. Allocation additionally imports the existing original `r16_shallow_nn_independent.py` from the restored source checkout; it does not import Torch, the producer, observer, protocol, or recovery adapter. The allocation test needs its sibling helper. There is no separate generation test file: generation includes `--self-test`.

## Original invocation forms

After staging exact source copies at the original evidence paths, with the matching pinned checkout and recovered exact-version runtime:

```sh
E=/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence
PY=/Users/EBmic/research-workspaces/history-forecasts-recovery-runtime/bin/python
export OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 PYTHONDONTWRITEBYTECODE=1
"$PY" "$E/verify_generation_fresh.py" --self-test
"$PY" "$E/test_verify_allocation_fresh.py" -v
"$PY" "$E/verify_generation_fresh.py" --out "$E/NEW-generation-independent.json"
"$PY" "$E/verify_allocation_fresh.py" --scope "$E/ALLOCATION-SCOPE.json" \
  --scope-sha256 ACTUAL_SCOPE_SHA256 --out-dir "$E/ALLOCATION-RUN" \
  --receipt "$E/NEW-allocation-independent.json"
```

These examples are invocation forms, not commands to run against absent or mismatched evidence. Generation verification reads all current admitted shard inputs; allocation verification reads current admitted inputs and proof chains. Both require genuine terminal artifacts and refuse an existing output receipt. Neither helper launches allocation or training. Synthetic tests do not establish historical forecast performance.

Another machine or directory layout requires an explicitly reviewed derivative with fresh path bindings, scope hashes, runtime qualification, genuine input identities and independent acceptance. Do not alter these archived originals or relabel their historical receipts. Preserve any failed verification evidence. Existing observations remain seen-development research, with the original contamination and model-weakness limitations.
