// Config-card collector file IO (review round 12, rules #8). The previous run's state is the
// carry's only memory (UQ-30 head breaches, run-to-run Safe and remote diffs, carried queue rows):
// a torn or unreadable state file must never silently become "first run".

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'

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
 * file by hand).
 */
export function readPreviousState(p) {
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) {
    throw new Error(
      `previous state ${p} exists but cannot be read (${e?.message ?? e}); refusing to run as a first run — restore it or delete it explicitly`,
    )
  }
}
