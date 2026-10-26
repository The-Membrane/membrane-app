# R16.4 downstream range diagnostic: parent verification source — CODEX CONTINUATION

These are exact copies of the parent monitor and independent acceptance validator actually used for the accepted337-world run, plus four synthetic size-sampling regression tests. They preserve operational proof code; applying this patch does not launch or repeat the benchmark.

- `q26-r164-range-uncertainty-parent-monitor.py`:6413bytes, SHA256 `4d1567370e7a344120f43e44e0016c64d7ecdcc206d1985b59dabb9badbdd034`.
- `q26-parent-accept-range-uncertainty.py`:8692bytes, SHA256 `4d1e2847830656da94459056e98e61de29e06ea58e1e33893ed3a57b6c3ee586`.

Original sources were `/private/tmp/` files with those names. Durable byte-identical copies were saved under `/Users/EBmic/research-workspaces/history-forecasts-recovery-evidence/durable-parent-verification-v1/` before packaging.

The executed monitor corrects a pre-launch fixture-deletion race: FileNotFoundError during recursive file-size sampling is ignored because completed synthetic fixtures are deleted between observations. PermissionError and other errors still propagate. Four tests AST-extract only `output_size`; they do not import the monitor, launch a child, import the validator, or read benchmark inputs/results. Cases are disappearance during is_file/stat, permission propagation, ordinary recursive size and absent root.

Run the tests with the approved Python, without launching either operational program:

```sh
OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 PYTHONDONTWRITEBYTECODE=1 /Users/EBmic/research-workspaces/history-forecasts-recovery-runtime/bin/python -m unittest -v test_parent_monitor_output_size.py
```

The original unexecuted pre-fix monitor was reconstructed byte-for-byte by restoring its one-line `output_size`, SHA256 `9f2bba4cd2f8be580e55570773321f708e744eca07613e72e7b4be83452a10bd`,6212bytes. It is preserved locally as `q26-r164-range-uncertainty-parent-monitor.pre-fix-unexecuted.py`, with explicit unexecuted status in preservation metadata. It is excluded from this runnable patch. This was a corrected review draft, not a failed benchmark.

The monitor enforces the existing300second/1GB RSS/2GB reserve/10MB recursive-output policy and final request/helper/test/nine-source/runtime-proof rehashes. The validator independently checks337 output pins and exact state weights,14 weighted aggregates,2359 original PartB descriptors and674 analytical PU/DIS CGM grids. Full all-world CAL/CALb metric reconciliation remains by the separately reviewed frozen helper/reference, not an independent parent reimplementation.

The operational programs retain their exact absolute local staging paths and evidence dependencies. This is source preservation, not a blanket portable execution claim. Four-block finite synthetic/fixed-seed scope, downstream-only supplied boot_q, and no market power, upstream fh_boot refit validation, model revision, promotion or NOT RUN change remain applicable.
