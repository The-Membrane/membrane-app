#!/usr/bin/env node
// Per-subject counts of the config-card files, for the re-collect summary
// (.github/workflows/oracle-config-collect.yml: "before -> after" in the commit body).
//
//   node scripts/oracle-registry/config/counts.mjs snapshot <out.json> [--dir=<config dir>] <subject>...
//        counts of <dir>/{state,changes,queues}/<subject>.json + the subject's cursor head
//        (dir: data/oracle-registry/config); a subject with no files yet is recorded as null
//   node scripts/oracle-registry/config/counts.mjs summary <before.json> <after.json> [--ok=a,b]
//        prints "head=<block>" (the highest head among the --ok subjects), then one line per
//        subject (before -> after; a subject not in --ok is listed as FAILED)
//   node scripts/oracle-registry/config/counts.mjs order [--dir=<config dir>] [--attempts=<file>] <subject>...
//        prints the subjects least recently tried first: the later of the last success
//        (cursors.json bySubject.<s>.runAt) and the last start (<file>: "<subject> <epoch s>"
//        lines, appended by the workflow); never tried first. A run cut short by a timeout is
//        picked up where it stopped, and a subject that keeps failing goes to the back instead
//        of taking every run's time first.
//
// Reads only committed-format JSON: no RPC, no network, no dependencies.

import { readFileSync, realpathSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

export const CONFIG_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'data',
  'oracle-registry',
  'config',
)

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

/** Counts for one subject, or null when it has no state file yet. */
export function subjectCounts(dir, key, cursors = {}) {
  let s
  try {
    s = readJson(join(dir, 'state', `${key}.json`))
  } catch (e) {
    if (e?.code === 'ENOENT') return null
    throw e
  }
  const rows = (kind) => {
    try {
      return readJson(join(dir, kind, `${key}.json`)).changes ?? []
    } catch (e) {
      if (e?.code === 'ENOENT') return []
      throw e
    }
  }
  const c = rows('changes')
  const q = rows('queues')
  const breaches = (s.items ?? []).flatMap((i) => i.breaches ?? [])
  return {
    head: cursors.bySubject?.[key]?.head ?? s.asOf?.block ?? null,
    red: s.counts?.red ?? 0,
    inEffect: c.filter((x) => x.red && x.stillInEffect).length,
    amber: s.counts?.pending ?? 0,
    proposed: s.counts?.proposed ?? 0,
    headBreaches: breaches.length,
    headBreachesCarried: breaches.filter((b) => b.carried || b.unconfirmed).length,
    readGaps: (s.readGaps ?? []).length,
    readGapRows: [...c, ...q].filter((x) => (x.tags ?? []).includes('read_gap')).length,
    floorBreaches: s.counts?.floorBreaches ?? 0,
    items: (s.items ?? []).length,
  }
}

function readCursors(dir) {
  try {
    return readJson(join(dir, 'cursors.json'))
  } catch (e) {
    if (e?.code === 'ENOENT') return {}
    throw e
  }
}

export function snapshot(dir, keys) {
  const cursors = readCursors(dir)
  return Object.fromEntries(keys.map((k) => [k, subjectCounts(dir, k, cursors)]))
}

/** "<subject> <epoch seconds>" lines -> { subject: latest start in ms }; other lines ignored. */
export function parseAttempts(text) {
  const out = {}
  for (const line of String(text).split('\n')) {
    const m = /^([a-z0-9-]+) (\d+)$/.exec(line.trim())
    if (!m) continue
    const t = Number(m[2]) * 1000
    if (!(out[m[1]] >= t)) out[m[1]] = t
  }
  return out
}

/**
 * `keys` least recently tried first: by the later of cursors.bySubject.<key>.runAt (the last
 * success) and attempts[key] (the last start, ms); a key with neither before all others; equal
 * times keep the requested order.
 */
export function stalestFirst(cursors, keys, attempts = {}) {
  const at = (k) => {
    const t = Date.parse(cursors?.bySubject?.[k]?.runAt)
    const a = attempts?.[k]
    return Math.max(Number.isFinite(t) ? t : -Infinity, Number.isFinite(a) ? a : -Infinity)
  }
  return keys
    .map((k, i) => ({ k, i, t: at(k) }))
    .sort((a, b) => (a.t === b.t ? a.i - b.i : a.t < b.t ? -1 : 1))
    .map((x) => x.k)
}

const FIELDS = [
  ['red', 'red'],
  ['inEffect', 'in-effect'],
  ['amber', 'amber'],
  ['headBreaches', 'head-breach'],
  ['readGaps', 'read-gap'],
  ['readGapRows', 'read-gap rows'],
]

const pair = (a, b) => `${a ?? '-'} -> ${b ?? '-'}`

/**
 * The commit summary. `ok`: the subjects whose collection succeeded (their head goes into the
 * title); every other subject in `after` is listed as FAILED with its committed counts kept.
 */
export function summarize(before, after, ok) {
  const okSet = new Set(ok)
  const heads = ok.map((k) => after[k]?.head).filter((h) => Number.isFinite(h))
  const lines = []
  for (const k of Object.keys(after)) {
    const b = before[k] ?? null
    const a = after[k] ?? null
    if (!okSet.has(k)) {
      lines.push(`${k}: FAILED (committed files kept)`)
      continue
    }
    if (!a) {
      lines.push(`${k}: no state file after the run`)
      continue
    }
    const parts = FIELDS.map(([f, label]) => `${label} ${pair(b?.[f], a[f])}`)
    lines.push(`${k}: ${parts.join(', ')} (head ${pair(b?.head, a.head)})`)
  }
  return { head: heads.length ? Math.max(...heads) : null, text: lines.join('\n') }
}

function main(argv) {
  const [cmd, ...rest] = argv
  const pos = rest.filter((a) => !a.startsWith('--'))
  const opt = (name) => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  if (cmd === 'snapshot') {
    const [out, ...keys] = pos
    if (!out || !keys.length)
      throw new Error('usage: counts.mjs snapshot <out.json> [--dir=<config dir>] <subject>...')
    const dir = opt('dir') ? resolve(opt('dir')) : CONFIG_DIR
    writeFileSync(out, JSON.stringify(snapshot(dir, keys), null, 1) + '\n')
    return
  }
  if (cmd === 'summary') {
    if (pos.length !== 2) throw new Error('usage: counts.mjs summary <before> <after> [--ok=a,b]')
    const after = readJson(pos[1])
    const okArg = opt('ok')
    const ok = okArg !== undefined ? okArg.split(',').filter(Boolean) : Object.keys(after)
    const { head, text } = summarize(readJson(pos[0]), after, ok)
    console.log(`head=${head ?? 'unknown'}`)
    console.log(text)
    return
  }
  if (cmd === 'order') {
    if (!pos.length)
      throw new Error('usage: counts.mjs order [--dir=<dir>] [--attempts=<file>] <subject>...')
    const dir = opt('dir') ? resolve(opt('dir')) : CONFIG_DIR
    let attempts = {}
    if (opt('attempts')) {
      try {
        attempts = parseAttempts(readFileSync(resolve(opt('attempts')), 'utf8'))
      } catch (e) {
        if (e?.code !== 'ENOENT') throw e
      }
    }
    console.log(stalestFirst(readCursors(dir), pos, attempts).join(' '))
    return
  }
  throw new Error('usage: counts.mjs snapshot|summary|order ...')
}

// Run as a script (also through a symlink): node resolves the module itself to its real path.
const invoked = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (invoked) main(process.argv.slice(2))
