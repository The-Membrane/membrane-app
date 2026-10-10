---
name: agent-message-board
description: >-
  Continuous externalization of discoveries to the shared Membrane agent board
  (AGENT_BOARD.md in the git repo triccs/membrane-board, cloned at
  ~/membrane-board; ~/AGENT_BOARD.md and each repo-root AGENT_BOARD.md are
  symlinks to it; shared by membrane-app, membrane-core, membrane-solidity and
  cloud agents; a write counts only once committed and pushed). Use at the START of any substantial task (read the board first),
  and DURING work whenever something is learned that another agent could not
  cheaply reconstruct: the real cause of a bug, a failed approach, an
  undocumented constraint, a consequential decision, a misleading assumption, a
  workaround, or non-obvious deployment/testing/API knowledge. Also use when
  the user says "check the board", "post to the board", "what do other agents
  know", or before leaving a task idle. This is NOT a session-end handoff
  skill: externalize the moment knowledge exists, because any agent's context
  can disappear at any time.
---

# Agent Message Board

## Purpose

Treat your own context as ephemeral and unreliable. Sessions crash, idle for
days, get resumed after compaction, or are abandoned. This skill makes the
**environment** responsible for remembering, so that another competent agent
can reconstruct reality without having experienced your work.

The board is **shared across all Membrane repos** (`membrane-app`,
`membrane-core`, `membrane-solidity`) and with cloud agents, because the work
— the EVM migration above all — crosses repo boundaries constantly.

**Where it lives (owner ruling 2026-10-06: all board usage goes to this repo).**
The board is `AGENT_BOARD.md` in the private git repo `triccs/membrane-board`,
cloned on the Mac at `~/membrane-board`. `~/AGENT_BOARD.md` and each repo-root
`AGENT_BOARD.md` are symlinks to the clone's file, so every path opens the same
file. Cloud sessions attach the repo instead.

**An edit is shared only after it is committed and pushed.** Cloud agents see
the GitHub copy, never the Mac's working tree. So every board write ends with
the repo's commit-and-push steps (`~/membrane-board/CLAUDE.md`):

```sh
cd ~/membrane-board
git pull --rebase --autostash origin main      # before you read or edit
# ... edit AGENT_BOARD.md ...
python3 scripts/board.py tag <TAG>             # must resolve to your entry
python3 scripts/test-board.py                  # must pass
git add AGENT_BOARD.md && git commit -m "board: <TAG> <one-line claim>"
git push origin HEAD:main                      # rejected? pull --rebase, retry; never force
```

The heading format, tags and read procedure are in the repo's `agent-board`
skill: `~/membrane-board/.claude/skills/agent-board/SKILL.md`. This skill says
*when* to write; that one says *how*.

If a repo-root symlink is missing, recreate it:
`ln -s ~/membrane-board/AGENT_BOARD.md <repo-root>/AGENT_BOARD.md`
(keep `AGENT_BOARD.md` in that repo's `.gitignore` — the symlink is
machine-local, never committed). Never commit a board copy into a code repo,
and never replace `~/membrane-board/AGENT_BOARD.md` with a symlink.

Because the board is cross-repo, every entry carries a `**Repo:**` line
naming which repo(s) the knowledge concerns (`all` for cross-cutting facts),
and file paths in `**Relevant:**` lines are repo-qualified
(`membrane-app/hooks/...`, `membrane-solidity/src/...`).

**Trust hierarchy** (most trustworthy first):

```
persistent project files (code, docs, config)
        ↓
AGENT_BOARD.md
        ↓
your current context          ← least trustworthy, can vanish mid-task
```

Never assume a future agent (including a resumed you) will have access to the
current conversation, or will remember why a decision was made.

## The Antimemetic Test — the central rule

Before and during work, keep asking:

> **"If my current context disappeared right now, would another competent
> agent lose information that would materially affect its ability to continue
> this work?"**

If yes: stop and externalize that information to the board **now**, not at the
end of the task. There is no reliable "end of the task."

## When to READ the board

Before beginning any substantial work (a feature, a bug hunt, a refactor, an
investigation):

1. `git -C ~/membrane-board pull --rebase --autostash origin main`. Then read
   the tree, not the text: `python3 ~/membrane-board/scripts/board.py toc
   --depth 2`, and `get` only the nodes that match the recent chapters and the
   files/subsystems you are about to touch. Never read the whole file.
2. Specifically look for: relevant **discoveries**, prior **decisions** and
   their reasoning, **warnings** about failed approaches, unresolved
   **blockers**/**questions**, and previous attempts at this exact problem.
3. Do not repeat work another agent has already performed. If a WARNING says an
   approach failed, do not retry it unless the stated preconditions changed.

Skip the read only for trivial turns (a one-line answer, a single-value
lookup, pure conversation).

## When to WRITE to the board

Write **during** work, at the moment of learning. Externalize when you:

- discover the **actual cause** of a bug (especially when it differs from the
  apparent cause)
- determine that an apparently reasonable **approach does not work**
- uncover an **undocumented architectural constraint** or invariant
- find an important **dependency between components** that the code does not
  make obvious
- make a **consequential decision** (architecture, library, data flow)
- discover a **misleading assumption** baked into existing code or docs
- identify a **workaround** and the reason it is needed
- learn something non-obvious about **deployment, testing, contracts, APIs,
  or infrastructure**

### Periodic externalization (required — do not wait for termination)

At each of these natural boundaries, ask *"what have I learned since my last
externalization that another agent would need?"* and post it if the answer is
non-empty:

- after solving a major problem
- after discovering an architectural constraint
- after completing an investigation (even one with a negative result)
- before switching to an unrelated task
- after several iterations of debugging (win or lose)
- before leaving a task idle or handing back to the user

Never rely on a clean session end to trigger writing. Assume there will not
be one.

## Entry format

Follow the repo `agent-board` skill's write procedure: a new chapter goes
directly ABOVE the newest `##` chapter as
`## YYYY-MM-DD — <status emoji> <KIND> <TAG>: <one-line claim>`, and a sub-item
goes under its chapter as `###`. Get a free tag with `scripts/board.py tags Q`
(or R/T/N/O-<area>). Write in controlled English: sentences of 25 words or
fewer, no semicolons. Inside the entry, keep these lines:

```md
### YYYY-MM-DD — <emoji> <KIND> <TAG>: <one-line claim>
<The claim, first line — `toc --gist` shows it.>
**Agent:** <task-slug or agent name; session id if you have one>
**Repo:** <membrane-app | membrane-core | membrane-solidity | all>

<Concise statement of the knowledge. One to four sentences.>

**Relevant:** `membrane-app/path/to/file.ts`, `membrane-solidity/src/...`

<Reasoning or evidence, when the "why" matters. Optional otherwise.>
```

KIND is one of `DISCOVERY`, `DECISION`, `WARNING`, `BLOCKER`, `QUESTION`,
`OBSERVATION`, `TODO`, `ARCHITECTURE`, `FIX`, `RULING`.

The write is not done until `git push` succeeds.

## Record decisions with their WHY

The board preserves reasoning, not just conclusions — the reasoning is exactly
the part that exists only in an agent's context.

Bad (fact only):

```md
We use Zustand.
```

Good (fact + constraint + guard against undoing it blindly):

```md
### DECISION
We use Zustand for portfolio state because the portfolio data is shared
across components that are not naturally connected through the React Query
tree. Do not migrate this to local component state without reconsidering the
cross-component synchronization requirement.
```

## Record failed paths

A dead end that cost you significant time will cost the next agent the same
time. Record it as a `WARNING` with: what was attempted, why it failed, and
under what conditions it might become viable.

```md
### WARNING
Attempted to fix stale portfolio data by raising React Query `staleTime`.
This did NOT resolve it: the stale value originates in `usePortfolioStore`,
upstream of the query cache. Do not repeat unless the store architecture
changes.
```

## Updating stale knowledge (supersede, do not contradict silently)

The board must not become a stream of contradictory statements. When you find
an existing entry is wrong or outdated:

1. Do not silently ignore it.
2. Strike the old heading's tag and mark it, e.g. `~~T14~~ — SUPERSEDED BY T16`,
   and leave its body intact (history matters for understanding the change).
3. Add a new entry with the corrected understanding, containing a
   `**Supersedes:**` line pointing at the old claim.

```md
### DECISION — SUPERSEDED
Previously believed CDT price was sourced directly from Pyth. Incorrect.

### DISCOVERY
The contract uses the TWAP adapter in `contracts/oracle/src/lib.rs`.
**Supersedes:** the Pyth-direct oracle assumption above.
```

Delete an entry outright only when it is both wrong and dangerous to leave
visible even marked superseded (rare).

## What NOT to record — the board is not a transcript

Do not post:

- routine coding actions, files opened, commands run
- trivial observations, or anything obvious from reading the code
- per-step progress narration ("now editing X", "tests passing")
- temporary thoughts with no value to a future agent
- duplicates of what CLAUDE.md, docs/, or git history already record

The filter is the board's one question: **"What does the next agent need to
know that it probably cannot infer quickly on its own?"** Compressed
knowledge, high signal. A handful of entries per working day is healthy; a
scroll of them is noise.

## The habit this skill installs

```
pull → read board → work → discover → externalize (commit + push) → continue working
```

not

```
work → finish → write handoff
```

You are not responsible for remembering. The board is.
