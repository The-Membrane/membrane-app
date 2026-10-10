// Config-card collector file IO (review round 12, rules #8). The previous run's state is the
// carry's only memory (UQ-30 head breaches, run-to-run Safe and remote diffs, carried queue rows):
// a torn or unreadable state file must never silently become "first run".

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * Write JSON through a temporary file in the same directory and an atomic rename: a full disk or
 * a killed process leaves the previous file whole (a plain writeFileSync truncated it first).
 */
export function writeJsonAtomic(p, o) {
  const tmp = `${p}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, JSON.stringify(o) + '\n')
    renameSync(tmp, p)
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* the original error is the one to report */
    }
    throw e
  }
}

/**
 * The previous run's state file: null when there is none (a first run). A file that exists but
 * cannot be read or parsed STOPS the run — it was read as null, which silently dropped every
 * carried breach, the run-to-run diffs and the carried queue rows (fail closed: fix or remove the
 * file by hand). Fail-closed audit (ST-01): a file that parses to something that is not an object
 * (`null`, a number) stops the run too — it was a silent first run.
 */
export function readPreviousState(p) {
  if (!existsSync(p)) return null
  let v
  try {
    v = JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    throw new Error(
      `previous state ${p} exists but cannot be read (${e?.message ?? e}); refusing to run as a first run — restore it or delete it explicitly`,
    )
  }
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error(
      `previous state ${p} exists but is not a state object; refusing to run as a first run — restore it or delete it explicitly`,
    )
  return v
}

/**
 * Fail-closed audit (ST-01, 2026-10-10): the previous run as a SET — state/, changes/ and
 * queues/<key>.json are written by one run and are its memory together (head breaches,
 * run-to-run diffs and carried history in state + changes, carried queue rows in queues). Each
 * file must be a version-1 file of this subject with a finite asOf block and its list, and all
 * three must come from the SAME run (equal asOf blocks): a torn set (a full disk between two
 * writes) mixed run N+1's state with run N's changes and lost the rows run N+1 created. A missing
 * state next to an existing changes / queues file is not a first run. Any of these STOPS the run.
 * No file at all: { state: null, changes: null, queues: null } (a first run).
 */
export function readPreviousSet(dir, key) {
  const path = (d) => join(dir, d, `${key}.json`)
  const state = readPreviousState(path('state'))
  const changes = readPreviousState(path('changes'))
  const queues = readPreviousState(path('queues'))
  if (!state && !changes && !queues) return { state: null, changes: null, queues: null }
  const bad = (what, why) => {
    throw new Error(
      `previous run of ${key}: ${what} ${why}; refusing to run — restore the set or delete all three explicitly`,
    )
  }
  if (!state) bad('state file', 'is missing while its changes / queues exist')
  const check = (f, what, list) => {
    if (!f) bad(`${what} file`, 'is missing while its state exists')
    if (f.version !== 1) bad(`${what} file`, `has version ${f.version}`)
    if (f.subject !== key) bad(`${what} file`, `is for subject ${f.subject}`)
    if (!Number.isFinite(f.asOf?.block)) bad(`${what} file`, 'has no asOf block')
    if (!Array.isArray(f[list])) bad(`${what} file`, `has no ${list} list`)
  }
  check(state, 'state', 'items')
  check(changes, 'changes', 'changes')
  check(queues, 'queues', 'changes')
  if (changes.asOf.block !== state.asOf.block || queues.asOf.block !== state.asOf.block)
    bad(
      'set',
      `is torn: state at block ${state.asOf.block}, changes at block ${changes.asOf.block}, queues at block ${queues.asOf.block}`,
    )
  return { state, changes, queues }
}

/**
 * Fail-closed audit (ST-01): write one subject's output with the STATE LAST — the state file is
 * the commit mark of the set (a write that fails before it leaves the previous set whole, which
 * `readPreviousSet` then refuses as torn rather than mixing two runs).
 */
export function writeSubjectFiles(dir, key, out, write = writeJsonAtomic) {
  const asOf = out.state.asOf
  write(join(dir, 'changes', `${key}.json`), {
    version: 1,
    subject: key,
    asOf,
    changes: out.changes,
  })
  write(join(dir, 'queues', `${key}.json`), { version: 1, subject: key, asOf, changes: out.queue })
  write(join(dir, 'state', `${key}.json`), out.state)
}

/**
 * Fail-closed audit (state files MISSED-2): `--rebuild` re-emits a subject from a raw captured by
 * an EARLIER run. A raw older than the current state would overwrite a newer run (its run-to-run
 * rows and carried breaches lost): refused unless forced.
 */
export function assertRebuildFresh(raw, prevState, force = false) {
  if (force || !prevState) return
  const at = Number(raw?.head?.block)
  const cur = Number(prevState?.asOf?.block)
  if (!Number.isFinite(at) || (Number.isFinite(cur) && at < cur))
    throw new Error(
      `--rebuild: the cached raw (block ${raw?.head?.block}) is older than the current state (block ${prevState?.asOf?.block}); refusing to overwrite a newer run (--force-stale to override)`,
    )
}

/**
 * Fail-closed audit (PO-07 / MISSED-1, 2026-10-10): the oracle collector's governance events
 * (data/oracle-registry/changes.json) — the only input of the oracle-dimension rows. A missing file
 * is a READ GAP (`unread`), never "no events"; a file that cannot be parsed, or that is not an
 * events file, STOPS the run (it was `{ events: [] }`: every oracle red row, and the window
 * warning, vanished with no gap).
 */
export function readOracleChanges(p) {
  if (!existsSync(p)) return { events: [], unread: 'data/oracle-registry/changes.json missing' }
  let j
  try {
    j = JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    throw new Error(
      `oracle governance events ${p} exist but cannot be read (${e?.message ?? e}); refusing to run — restore or regenerate it`,
    )
  }
  if (!j || typeof j !== 'object' || !Array.isArray(j.events))
    throw new Error(`oracle governance events ${p} are not an events file; refusing to run`)
  return j
}
