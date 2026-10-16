---
name: deepen-prompt
description: "Turn a user prompt into a deeper version of the same task before you do it — not a bigger one. A UserPromptSubmit hook (from the deepen-prompt plugin, or a repo's own copy) tells you to load this skill on each user prompt. Load it when that hook reminder appears, and when the user says: deepen this, deeper version, what would a top professional do, rewrite my prompt, start from raw material, how would we know this is right. You write four answers (professional moves not asked for, rawest material, methods and tools, an external check), rewrite the prompt, then do the rewritten task. Skip it for a prompt that starts with `raw:` or `/`, or a short reply such as yes or go. Not for judging whether a finished claim is verified, and not for a wording-only rewrite."
---

<!-- Copy of triccs/membrane-solidity `plugins/deepen-prompt` v1.1.0. Edit it there, then copy it here. The plugin and this copy print one reminder per prompt between them. -->

# deepen-prompt — a deeper version of the task, not a bigger one

Source: a user-supplied meta-prompt (2026-10-16). Its text:

<!-- ste-off -->
> I want a deeper version of this task, not a bigger one. Before rewriting it:
> (1) say what a top professional in this field would do here that I'm not
> asking for; (2) name the rawest material they would start from instead of
> what has already been digested for me; (3) name the specific methods and
> tools they would use; (4) say what, other than you or me, would show the
> result is right. Then rewrite my prompt to ask for exactly that.
<!-- ste-on -->

The hook `hooks/deepen-prompt.py` adds a reminder to each user prompt. It
comes from the deepen-prompt plugin or from a repo's own copy. When both run,
only one reminder appears. The reminder tells you to apply this skill. The hook skips a prompt that starts
with `raw:` or `/`, and a prompt of fewer than 4 words. It also skips a message
from the harness, such as a sub-agent report or a task notification. The
environment variable `DEEPEN_PROMPT=off` turns the hook off for a session.

## When to skip

Skip the procedure and do the task when one of these is true:

- The prompt is an answer to a question that you asked.
- The prompt is one mechanical action, such as "push the branch" or "run the tests".
- The prompt continues a task that you already deepened in this session.
- The message is a sub-agent report or other harness message that the hook did not catch.

Write one line that says why you skipped. Then do the task.

## Procedure

1. Name the field. Example: "EVM protocol architecture", "frontend state management".
2. Write answer 1: the professional moves. List 2 to 5 things that a top
   professional in that field does here that the prompt does not ask for.
   Each item must change the result. Do not list a new deliverable.
3. Write answer 2: the rawest material. Name the primary sources by path or
   command. Name the digested sources that you will NOT start from. If the
   repo documents its own primary sources (`CLAUDE.md`, `AGENTS.md`, a repo
   skill), use that list.
4. Write answer 3: the methods and tools. Name each method and the exact
   command or tool. Use only tools that exist in this environment. Check with
   `which <tool>` before you name a binary.
5. Write answer 4: the external check. Name something other than you or the
   user that can show the result is right or wrong. Examples: a script that
   fails on a wrong result, the test suite, the compiler, the source code, a
   recorded decision. If no external check exists, say so. Then make the
   smallest check that can fail. A check that proves only existence or format
   (a symbol exists, a schema parses) does not prove content. Add a seeded
   random sample that someone else audits, and report its error rate.
6. Rewrite the prompt. Ask for exactly the result of answers 1 to 4. Keep the
   deliverable the same size or smaller than the original request.
7. Do the rewritten task. Do not wait for approval, unless the rewrite changes
   which deliverable the user gets. In that case, ask first.
8. Run the external check from step 5. Report its result as the last line of
   your answer. If the check failed, say so.

## Output shape

Keep the four answers short. Put them before the work, in this form:

```text
Deepen (field: <field>)
1. Professional moves: ...
2. Rawest material: ... (not: <digested sources>)
3. Methods and tools: ...
4. External check: ...
Rewritten prompt: "<one paragraph>"
```

For a large task, also write the four answers and the rewritten prompt into
the deliverable. A later session can then see the basis.

## Raw and digested material

| Rawest material | Digested material (do not start from it) |
|---|---|
| source code, scripts, config files | skills, wikis, architecture summaries |
| test output, CI logs, compiler errors | status counts and badges in docs |
| a formal spec or a schema | a prose summary of it |
| the decision record (an ADR, a ruling, an issue thread) | a recap of it in chat |
| `git log`, `git diff`, the PR diff | the PR description |
| primary data, query results | a report or a dashboard built on them |

Docs and skills help you find the raw material. Do not cite them as proof.

## Bigger versus deeper

A deeper task has the same deliverable with more rigor. A bigger task adds
deliverables. These are bigger, so do not add them:

- a second document that repeats the first one
- new features that the user did not ask for
- a full audit when the user asked for one function

These are deeper, so add them:

- citations to source lines instead of to docs
- a check that can fail
- the edge cases and the forbidden states
- a clear mark on each guess, with its basis
