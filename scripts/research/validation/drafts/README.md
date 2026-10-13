# drafts/ — schedules that are NOT enabled

`m1-live.yml` is the prereg T5.4 draft (triccs/membrane-board `design/VALIDATION_PREREG.md`, commit
506e7c5) of a daily GitHub Actions run of the live M1 log:

| UTC | step | script | writes to triccs/membrane-datasets `main` |
|---|---|---|---|
| 00:07 | issue (T5.1) | `m1_issue.py --commit` | `forecasts/m1-live/YYYY-MM-DD.json`, `forecasts/m1-live/chain.jsonl` |
| 00:07 | chain snapshot (T5.2) | `deribit_chain_snapshot.py --commit` | `deribit-chain/YYYY-MM-DD/*.json.gz`, `MANIFEST.md` |
| 00:37 | score (T5.3) | `m1_score.py --commit` | `forecasts/m1-live/scores/scores.json`, `summary.json` |

It lives here, not in `.github/workflows/`, so it cannot run. Until it is enabled, issues happen only
when a session runs the issuer by hand in real time (T5.4).

## What enabling needs (owner approval, Q25)

Prereg rule 0: "No schedule, deployment, paid source or sign-up without owner approval." Enabling
this file is a schedule, so the owner must approve it explicitly. Then:

1. **Deploy key.** Create an SSH key pair. Add the public key to `triccs/membrane-datasets` →
   Settings → Deploy keys, with **write access** (the repo is private, so the key is needed for the
   checkout as well as the push). Store the private key in `The-Membrane/membrane-app` → Settings →
   Secrets and variables → Actions as **`DATASETS_DEPLOY_KEY`**. Nothing else is needed: the scripts use
   public, keyless endpoints only (Deribit public REST and public Ethereum JSON-RPC).
2. **Location.** Copy `m1-live.yml` to `.github/workflows/m1-live.yml` on the membrane-app **default
   branch (`main`)**. GitHub runs `schedule` triggers only from workflow files on the default branch.
   The workflow itself checks out the code from `research/validation-pilots`.
3. **Committed code.** `--commit` refuses to run when the scripts differ from the checked-out commit
   (`gitDirty`), so every day file names the commit that produced it. A fresh Actions checkout is clean.

## Things the owner should know before approving

- **Timestamps.** The issuer stamps `issuedAt` from the runner clock at start; `asof` is that time
  floored to the hour. The GitHub push time of the commit is the external timestamp (T5.1). GitHub
  can start scheduled runs late (often minutes, sometimes more), so 00:07 is a target, not a
  guarantee. A late run issues with its own real time; a missed day stays missing. Nothing is
  backdated and no option can set `issuedAt`.
- **Day files are immutable.** The issuer refuses to write a second file for a UTC date or to
  overwrite one. Each file carries `prevSha256` (hash chain); the scorer stops if the chain is broken.
- **Public RPC limits.** Public endpoints can rate-limit or fail. The client falls back across a fixed
  list and has a call budget. The scorer re-reads every Chainlink round since the first issue on each
  run (no cache), about 80 `eth_call`s per elapsed day (≈ 1.6 batched requests per day at batch 50).
- **Inactivity.** GitHub disables scheduled workflows in public repositories after 60 days without
  repository activity; the daily datasets commits do not count, because they go to another repo.
- **Disable.** Delete the file from `.github/workflows/` or disable the workflow in the Actions tab.

## By hand (until approval)

```bash
cd membrane-app   # branch research/validation-pilots, scripts committed
python3 scripts/research/validation/m1_issue.py --datasets ../membrane-datasets --out ../membrane-datasets --commit
python3 scripts/research/validation/deribit_chain_snapshot.py --out ../membrane-datasets --commit
python3 scripts/research/validation/m1_score.py --datasets ../membrane-datasets --out ../membrane-datasets --commit
```
