---
name: free-disk-space
description: >-
  Safely free disk space on a developer machine with scripts/disk-cleanup.sh: deletes regenerable
  build output (node_modules, .next, Rust target, gitignored dist/build), prunes tool caches (pnpm,
  npm, Yarn, Cargo, Playwright, Homebrew, Xcode, Docker images) and removes stale git worktrees
  that Claude Code left behind, while keeping branches, commits and .env files. Use whenever the
  user says their disk is full, asks to free or reclaim disk space, hits "no space left on device"
  or ENOSPC, wants to clean up old worktrees, node_modules, build folders or caches, or asks to run
  scripts/disk-cleanup.sh, even if they only say "my disk is full again" or "clean up my machine".
---

# Free disk space

`scripts/disk-cleanup.sh` (repo root) does the work. This skill is the procedure that makes
running it with `--apply` safe: **dry run → show the user → apply only what they approved → report**.

## What the script can and cannot touch

| Section | What it deletes | Cost of deleting | Guard |
|---|---|---|---|
| 1. Build output | `node_modules`, `.next`, `.turbo`, `target`, and `dist`/`build`/`out`/`coverage` only when gitignored | Re-run `pnpm install` / build | Skips any project with a file edited in the last 14 days (`--older`) |
| 2. Caches | pnpm store (unused packages), npm, Yarn, Bun, Cargo downloads, pip, Go, Playwright browsers, Foundry, Homebrew, Xcode | Re-download on next use; Playwright needs `npx playwright install` | Docker: images and build cache only, never volumes |
| 3. Worktrees | Clean worktrees (no uncommitted files). With `--park`: also worktrees with unsaved work | None: the branch and commits stay in the repo | Backs up gitignored files like `.env` first; writes restore commands to `~/.disk-cleanup/worktrees.log`; skips locked or recently edited worktrees |
| 4. Review by hand | Nothing. Lists files over 500 MB, chain data dirs (may contain keys), Trash, Time Machine snapshots | n/a | Report only |

It never touches git history, the main checkout of any repo, Docker volumes, hidden dirs such as
`~/.nvm` or `~/.vscode`, or `~/Library` outside the listed caches. It refuses to run as root.

## Procedure

### 1. Dry run

From the membrane-app root:

```sh
scripts/disk-cleanup.sh
```

- It scans `~/code ~/dev ~/src ~/projects ~/repos ~/github ~/Developer ~/workspace ~/conductor
  ~/Documents/GitHub`, whichever exist. If the output says no project folders were found, or the
  user keeps repos elsewhere, ask where and add `--root <dir>` (repeatable).
- Large trees take a few minutes. Give the command a long timeout (10 min) rather than
  interrupting it.

### 2. Show the user before deleting anything

Summarize the dry run in a few lines:

- Free space now, and the estimated total per section.
- The 3–5 biggest items in sections 1 and 2.
- Each worktree by name and state: `[clean]` will be removed; `[unsaved]` needs `--park`;
  `[active]`, `[locked]` are kept; `[missing]` gets pruned.
- Anything notable in section 4, as suggestions for the user to handle themselves.

Then ask which sections to apply. Recommend `artifacts,caches,worktrees` with no `--park`: it
removes only regenerable data and clean worktrees.

### 3. Apply exactly what was approved

```sh
scripts/disk-cleanup.sh --apply --yes --only <approved sections>
```

- `--yes` is required when Claude runs it. With no terminal attached, `--apply` alone deletes
  nothing: every step reports "skipped: no terminal to confirm". That's the safety net, so pass
  `--yes` only after the user approves in step 2, and reuse the same `--root`/`--older` values the
  dry run used, so the apply covers what the user saw.
- Add `--park` only when the user explicitly asks to clear worktrees with unsaved work. Tell them
  first: it makes a local commit `wip: parked by disk-cleanup` with `--no-verify` on each such
  worktree (detached HEADs get a `wip/parked-*` branch), pushes nothing, then removes the folder.
- Add `--older 0` only if the user asks to include recently edited projects.
- If the user relies on locally built Docker images that aren't in a registry, leave `caches` out
  of `--only` (there is no per-cache switch) and run only the cache commands they want, such as
  `pnpm store prune` or `npm cache clean --force`.

### 4. Report

- Quote the script's `Freed X. Free space now: Y` line.
- If worktrees were removed, point to `~/.disk-cleanup/worktrees.log` and say how to restore one
  (below).
- If the current project's `node_modules` was deleted, run `pnpm install` before running tests or
  the dev server.

## Restoring a removed worktree

Each entry in `~/.disk-cleanup/worktrees.log` lists the exact commands, for example:

```sh
git -C ~/code/membrane-app worktree add ~/code/membrane-app/.claude/worktrees/foo feat/foo
git -C ~/code/membrane-app/.claude/worktrees/foo reset HEAD~1   # only for parked worktrees: undo the WIP commit
cp -R ~/.disk-cleanup/worktree-backups/membrane-app/foo-<stamp>/. ~/code/membrane-app/.claude/worktrees/foo/
```

## Rules

- ❌ Never run with `sudo`, and never set `DISK_CLEANUP_ALLOW_ROOT=1` on a personal machine. That
  variable is only for containers where root is the normal user.
- ❌ Never `rm -rf` anything the script skipped or only reported (section 4, `[active]`,
  `[unsaved]` without `--park`, chain data). If the user wants something else gone, confirm the
  exact path with them first.
- ❌ Never push `wip/parked-*` branches or WIP commits.
- ❌ Never use `--force` on `git worktree remove` when the script reports git refused.
- ✅ Always dry-run first in the same session, even if the user says "just run --apply". Running
  `scripts/disk-cleanup.sh --apply` without `--yes` counts as that dry run: it lists everything,
  deletes nothing, and ends with the number of skipped steps.
- ✅ When the user runs it in their own terminal, plain `scripts/disk-cleanup.sh --apply` is safe
  too: it asks y/N before every step.

## Keeping it from coming back

- Weekly dry run: `scripts/disk-cleanup.sh --only artifacts,worktrees`.
- Remove a worktree once its branch merges: `git worktree remove <path>`.
- Use pnpm in worktrees, never npm. pnpm shares one package store, so each extra worktree costs
  little.
- To use this skill outside membrane-app, copy `.claude/skills/free-disk-space/` to
  `~/.claude/skills/` and `scripts/disk-cleanup.sh` to somewhere on `PATH`, then call it by that
  path.
