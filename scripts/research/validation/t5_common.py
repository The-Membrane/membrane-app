#!/usr/bin/env python3
"""Shared helpers for the T5 live-logging scripts (m1_issue.py, m1_score.py, deribit_chain_snapshot.py).

Implements plumbing only (time formatting, sha256, HTTP GET with retries, the day-file hash chain
check, code provenance, git commit/push). The registered logic lives in the three scripts.
stdlib only.
"""
import hashlib
import http.client
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
USER_AGENT = "membrane-validation/1 (research; python-urllib)"  # publicnode answers 403 to the urllib default UA
ZERO_SHA = "0" * 64
DAY_FILE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.json$")
HOUR = 3600
DAY = 86400

PREREG = {"repo": "triccs/membrane-board", "path": "design/VALIDATION_PREREG.md", "commit": "506e7c5"}


# ---------------------------------------------------------------------------------------------
# Time / hashing
# ---------------------------------------------------------------------------------------------
def iso(ts):
    return datetime.fromtimestamp(int(ts), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def utc_date(ts):
    return datetime.fromtimestamp(int(ts), timezone.utc).strftime("%Y-%m-%d")


def compact_stamp(ts):
    return datetime.fromtimestamp(int(ts), timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def floor_hour(ts):
    ts = int(ts)
    return ts - ts % HOUR


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_exclusive(path, data):
    """Create `path` with `data` (bytes). Refuses (FileExistsError) if the path exists: never overwrites."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "xb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())


def write_atomic(path, data):
    """Replace `path` with `data` (bytes) atomically. Only for derived files (scores), never day files."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def dumps(obj):
    return (json.dumps(obj, indent=2, ensure_ascii=True) + "\n").encode()


# ---------------------------------------------------------------------------------------------
# HTTP GET (Deribit)
# ---------------------------------------------------------------------------------------------
def urllib_get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def get_with_retry(url, get=None, tries=4, backoff=2.0, sleep=time.sleep):
    """GET `url` -> raw bytes. Retries with exponential backoff; raises the last error."""
    get = get or urllib_get
    for i in range(tries):
        try:
            return get(url)
        except (urllib.error.URLError, http.client.HTTPException, OSError, TimeoutError, ValueError):
            if i == tries - 1:
                raise
            sleep(backoff * (2 ** i))


# ---------------------------------------------------------------------------------------------
# Day-file hash chain (T5.1)
# ---------------------------------------------------------------------------------------------
def list_day_files(day_dir):
    """Sorted [(date, filename)] of YYYY-MM-DD.json files in day_dir."""
    if not os.path.isdir(day_dir):
        return []
    out = []
    for name in os.listdir(day_dir):
        m = DAY_FILE_RE.match(name)
        if m:
            out.append((m.group(1), name))
    return sorted(out)


def read_chain_jsonl(day_dir):
    path = os.path.join(day_dir, "chain.jsonl")
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def verify_chain(day_dir):
    """Check every day file and chain.jsonl line. Returns a list of problems ([] = intact).

    file[0].prevSha256 = 64 zeros, prevFile = null; file[i].prevSha256 = sha256(bytes of file[i-1]),
    prevFile = name of file[i-1]; selfSha256Excluded = true; chain.jsonl line i = file i with the
    sha256 of its current bytes."""
    problems = []
    files = list_day_files(day_dir)
    entries = read_chain_jsonl(day_dir)
    if len(entries) != len(files):
        problems.append(f"chain.jsonl has {len(entries)} lines but there are {len(files)} day files")
    prev_sha, prev_name = ZERO_SHA, None
    for i, (date, name) in enumerate(files):
        with open(os.path.join(day_dir, name), "rb") as f:
            raw = f.read()
        sha = sha256_bytes(raw)
        try:
            doc = json.loads(raw)
        except ValueError:
            problems.append(f"{name}: not valid JSON")
            prev_sha, prev_name = sha, name
            continue
        if doc.get("date") != date:
            problems.append(f"{name}: date field {doc.get('date')!r} != file name")
        if doc.get("prevSha256") != prev_sha:
            problems.append(f"{name}: prevSha256 {doc.get('prevSha256')} != sha256 of {prev_name or 'genesis'} "
                            f"{prev_sha}")
        if doc.get("prevFile") != prev_name:
            problems.append(f"{name}: prevFile {doc.get('prevFile')!r} != {prev_name!r}")
        if doc.get("selfSha256Excluded") is not True:
            problems.append(f"{name}: selfSha256Excluded is not true")
        if i < len(entries):
            e = entries[i]
            if e.get("file") != name or e.get("date") != date:
                problems.append(f"chain.jsonl line {i + 1} names {e.get('file')!r}, expected {name!r}")
            if e.get("sha256") != sha:
                problems.append(f"chain.jsonl line {i + 1}: sha256 {e.get('sha256')} != current bytes of {name} "
                                f"{sha} (file changed after issue?)")
            if e.get("prevSha256") != prev_sha:
                problems.append(f"chain.jsonl line {i + 1}: prevSha256 does not link to {prev_name or 'genesis'}")
        prev_sha, prev_name = sha, name
    return problems


# ---------------------------------------------------------------------------------------------
# Code provenance + git
# ---------------------------------------------------------------------------------------------
def _git(repo, *args, check=True):
    r = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed ({r.returncode}): {r.stderr.strip()}")
    return r


def code_provenance(main_file, deps):
    """{path, gitCommit, gitDirty, sha256: {file: sha}} for the script and its imported modules.
    gitDirty = any of these files differs from HEAD or is untracked."""
    names = [os.path.basename(main_file)] + [os.path.basename(d) for d in deps]
    out = {"path": "scripts/research/validation/" + names[0],
           "sha256": {n: sha256_file(os.path.join(HERE, n)) for n in names},
           "gitCommit": None, "gitDirty": None}
    try:
        out["gitCommit"] = _git(HERE, "rev-parse", "HEAD").stdout.strip()
        st = _git(HERE, "status", "--porcelain", "--", *names).stdout.strip()
        out["gitDirty"] = bool(st)
    except (RuntimeError, OSError):
        pass
    return out


def require_clean_code(prov):
    if prov.get("gitCommit") is None or prov.get("gitDirty"):
        raise SystemExit("STOP: --commit needs the issuing code committed (gitDirty=false), so the recorded "
                         "gitCommit holds the code that ran. Commit the scripts first.")


def commit_and_push(out_dir, rel_paths, message, log=print):
    """git add + commit ONLY rel_paths (relative to the repo top level) + push origin main.
    One retry after `git pull --rebase --autostash origin main` if the push is rejected."""
    top = _git(out_dir, "rev-parse", "--show-toplevel").stdout.strip()
    branch = _git(top, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    if branch != "main":
        raise SystemExit(f"STOP: datasets checkout is on {branch!r}, expected main")
    _git(top, "add", "--", *rel_paths)
    _git(top, "commit", "-m", message, "--", *rel_paths)
    sha = _git(top, "rev-parse", "HEAD").stdout.strip()
    r = _git(top, "push", "origin", "main", check=False)
    if r.returncode != 0:
        log("push rejected; rebasing onto origin/main once")
        _git(top, "pull", "--rebase", "--autostash", "origin", "main")
        _git(top, "push", "origin", "main")
        sha = _git(top, "rev-parse", "HEAD").stdout.strip()
    log(f"committed and pushed {sha[:10]}: {message}")
    return sha


def repo_relpaths(out_dir, abs_paths):
    top = _git(out_dir, "rev-parse", "--show-toplevel").stdout.strip()
    top = os.path.realpath(top)
    return [os.path.relpath(os.path.realpath(p), top) for p in abs_paths]
