#!/usr/bin/env python3
# Copy of triccs/membrane-solidity `plugins/deepen-prompt` v1.2.0. Edit it there, then copy it here. The plugin and this copy print one reminder per prompt between them.
"""UserPromptSubmit hook of the deepen-prompt plugin: apply its skill to each user prompt.

Reads the hook payload (JSON on stdin) and, unless the prompt is exempt, prints
a JSON `additionalContext` that tells the agent to load `deepen-prompt:deepen-prompt` and
deepen the prompt before it acts. The hook never blocks a prompt: bad input or
an exempt prompt exits 0 with no output. An internal error prints one line to
stderr and exits 0.

Exempt prompts:
  - start with `raw:` (the user opts out for that one prompt)
  - start with `/` (a slash command already carries its own procedure)
  - have fewer than MIN_WORDS words ("yes", "push it", "go ahead")
  - are a harness envelope, not user text (a sub-agent hand-back, a task
    notification, a PR-event wake): see ENVELOPES
  - env DEEPEN_PROMPT=off (opts out for the whole session)

One reminder per prompt: the plugin and a repo's own copy of this hook can both
run for the same prompt. Each run claims a marker for (session, prompt) with an
atomic create. Only the run that creates it prints. A marker older than
CLAIM_TTL_S does not count, so the user can send the same prompt again later.
If the marker cannot be written, the hook prints (a duplicate is better than
no reminder). DEEPEN_PROMPT_CLAIMS_DIR overrides the marker folder (tests).
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import time

MIN_WORDS = 4
CLAIM_TTL_S = 10
OPT_OUT = "raw:"
# Text the harness delivers through UserPromptSubmit that the user did not type.
ENVELOPES = ("<agent-message", "Another Claude session sent a message", "<task-notification", "<wake ")

REMINDER = (
    "deepen-prompt: before you act on this prompt, load the `deepen-prompt` skill (listed as "
    "`deepen-prompt:deepen-prompt` when it comes from the plugin) and apply it. First find and read the "
    "field's oracles (its standards, maintainers' docs and leading practitioners), then write the four "
    "answers (professional moves not asked for, rawest material, methods and tools, the external check), "
    "rewrite the prompt to ask for exactly that, then do the rewritten task. Deeper, not bigger. "
    f"The user can skip this for one prompt with the prefix `{OPT_OUT}`."
)


def exempt(prompt: str) -> bool:
    text = prompt.strip()
    if text.lower().startswith(OPT_OUT) or text.startswith("/"):
        return True
    if text.startswith(ENVELOPES):
        return True
    return len(text.split()) < MIN_WORDS


def first_claim(session: str, prompt: str) -> bool:
    """True for exactly one of several hook runs on the same prompt."""
    folder = os.environ.get("DEEPEN_PROMPT_CLAIMS_DIR") or os.path.join(tempfile.gettempdir(), "deepen-prompt-claims")
    key = hashlib.sha256(f"{session}\0{prompt}".encode("utf-8", "surrogatepass")).hexdigest()[:32]
    path = os.path.join(folder, key)
    try:
        os.makedirs(folder, exist_ok=True)
        for _ in range(2):
            try:
                os.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
                break
            except FileExistsError:
                if time.time() - os.path.getmtime(path) < CLAIM_TTL_S:
                    return False
                os.unlink(path)  # an old claim: the user sent the same prompt again
        now = time.time()
        for name in os.listdir(folder):  # prune claims older than an hour
            old = os.path.join(folder, name)
            if now - os.path.getmtime(old) > 3600:
                os.unlink(old)
    except OSError:
        return True
    return True


def main() -> int:
    if os.environ.get("DEEPEN_PROMPT", "").strip().lower() == "off":
        return 0
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except ValueError:  # includes UnicodeDecodeError
        return 0
    prompt = payload.get("prompt") if isinstance(payload, dict) else None
    if not isinstance(prompt, str) or exempt(prompt):
        return 0
    if not first_claim(str(payload.get("session_id", "")), prompt):
        return 0
    out = {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": REMINDER}}
    try:
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()
    except BrokenPipeError:  # per the Python docs on SIGPIPE: no second error at exit
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # a hook bug must never block the user's prompt
        sys.stderr.write(f"deepen-prompt hook: internal error: {type(e).__name__}: {e}\n")
        sys.exit(0)
