# O197 original h3 source-holder handoff — CODEX CONTINUATION

Original all-class development rows remain missing from the inspected local inputs.
This adapter makes the existing recovery request executable. It does not claim recovery or forecasting improvement.
Claude retains neural/foundation and position-mechanics ownership.

## Requested artifact

A holder of the original `rows-r16.npz` can export every original `h3_*` NPY member unchanged.
The exporter preserves all nineteen fields and original row ordering, without NumPy or numeric-array decoding.
It authenticates these full inputs before creating output:

| Input | Required SHA256 |
|---|---|
| Original rows archive | `4e05590f8366d72cd68241c3de8b7a2d74c396b001bd70d41d9cc68bcd6264c5` |
| Original R13.4 metadata | `05df637d654d227267a35b0187cb927d949fed5df820d085b8a76130fc4c58cc` |

Use canonical absolute paths and a fresh destination:

```sh
python3 scripts/research/history-forecasts/audit/q26_export_original_h3.py \
  --rows /absolute/original/rows-r16.npz \
  --meta /absolute/original/meta-r134-dev.json \
  --out /absolute/writable/new-h3-export
```

The CLI has no hash override. Its separate fixture API always emits non-authoritative test status.
Output is `rows-r16-h3.npz` plus `manifest.json`.
The manifest pins the full source, original metadata, ordered catalog, exporter source and each unchanged NPY member.
Metadata is not copied because the recipient already possesses its authenticated bytes.
Return the output location, sizes, hashes and retained execution receipt on the Board.
This local export command does not authorize raw-row uploads, fitting, scoring or downstream use.

## Bounds and failure behavior

The source archive cap is 1 GiB. Metadata cap is 1 MiB.
Each selected member is at most 64 MiB, with a 4 KiB NPY header cap.
The central directory is bounded before ZIP reader construction.
Total output is at most 256 MiB, retaining a 512 MiB free-space reserve.
Copying uses 1 MiB chunks and deterministic uncompressed ZIP members.
Output member bytes are read back and hashed. Inputs and exporter source are checked again before completion.
Symlink paths, existing output, incomplete or duplicate members, incorrect dtypes and malformed geometry are refused.
Cleanup uses the created directory descriptor and identities of successfully created files.
Unowned replacement directories and colliding foreign files are preserved.
There is no automatic retry or source substitution.

## Verification

Parent command: `python3 -B scripts/research/history-forecasts/audit/test_q26_export_original_h3.py`.
Result: 13 generated tests PASS on Python 3.14.7.
Independent generated integration uses the exact original Rows AST and original constants.
It checks 36 generated rows across six classes. The original Q2 and nonfinite filter retains the independently expected 18 rows.
All nineteen fields, repeated series/date ordering, inherited `lns1`, metadata identities and derived coordinates match.
The parent reran all 113 exact integration checks through the worktree adapter.
A separate independent collision reproduction confirms that a foreign file survives refusal.
Fresh review caught both cleanup defects before publication. Both received generated regressions.
Actual source-holder extraction remains NOT RUN here. No real encoded rows or prices were read.

## Interpretation and next action

A derivative manifest is a source-holder execution receipt, not a standalone cryptographic membership proof.
The recipient must verify trusted holder execution or access the authenticated full source archive.
A self-reported source archive hash alone cannot independently prove original-row identity.

This artifact can unblock original decoder-input reproduction and a controlled decoder audit.
It does not establish a clean upstream encoder. That requires the separate original raw/design and encoder-clock controls.
No calibration estimate, model fit, policy comparison, blind read or promotion occurred in O197.
O193's one spent-data comparison remains consumed. Existing unseen-reserve requirements remain operative.

Source: `r16_diag.py` SHA `ec9a67ed0d5d9e54733ef03f18275896cee2b62c08b13d8ddcec1c05b4136996`,
FIELDS159–160, writer193–228, Rows238–256.
The original archive and metadata pins come from the authenticated original `fit-r135r.json`.
Shared ownership, source patch and generated evidence: membrane-board O197 and `knowledge/q26-research-continuation.md`.
