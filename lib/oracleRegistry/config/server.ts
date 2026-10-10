// File loader for the CONFIG CARDS view (server only: API routes and getServerSideProps).
// Reads data/oracle-registry/config/{subjects.json,state,changes,queues,lz-metadata.json},
// memoised per subject until one of its files changes (sUSDe's change file is ~1 MB).
//
// Every read is tolerant: a missing or malformed file becomes null / empty, never a throw, so
// a deploy without collector output still renders the subject with `available: false`.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { getOracleCatalog } from '../catalog'
import type { ConfigCardView, ConfigIndexResponse, ConfigTabSummary } from './apiTypes'
import { getConfigSubjects } from './subjects'
import type { ConfigChange, ConfigSubject, SubjectState } from './types'
import {
  buildConfigCard,
  buildConfigSummary,
  type BuildCardOptions,
  type ChangesFile,
  type ConfigInputs,
  subjectSlug,
} from './view'

export const configDir = (): string => join(process.cwd(), 'data', 'oracle-registry', 'config')

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Fail-closed audit (ST-06, 2026-10-10): a file read as missing / unreadable / ok — an unreadable
 * change file is NOT "no changes" (it served 0 red in effect, calm, over a truncated file).
 */
function readJsonStatus(path: string): { status: 'missing' | 'unreadable' | 'ok'; value: unknown } {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    return {
      status: (e as { code?: string })?.code === 'ENOENT' ? 'missing' : 'unreadable',
      value: null,
    }
  }
  try {
    return { status: 'ok', value: JSON.parse(text) }
  } catch {
    return { status: 'unreadable', value: null }
  }
}

function mtime(path: string): string {
  try {
    return String(statSync(path).mtimeMs)
  } catch {
    return '-'
  }
}

function asState(raw: unknown, key: string): SubjectState | null {
  const s = raw as SubjectState | null
  return s &&
    s.version === 1 &&
    s.subject === key &&
    Array.isArray(s.items) &&
    Array.isArray(s.powers) &&
    s.asOf &&
    Number.isFinite(s.asOf.block)
    ? s
    : null
}

function asChanges(raw: unknown): ConfigChange[] {
  const f = raw as ChangesFile | null
  return f && Array.isArray(f.changes) ? f.changes : []
}

/**
 * A change / queue file checked against the state it belongs to (ST-06): version 1, this
 * subject, the same run (asOf block), a list — and, for the change file, as many rows as the
 * state counted. Anything else is a read gap; the rows are not trusted.
 */
function checkedRows(
  read: { status: 'missing' | 'unreadable' | 'ok'; value: unknown },
  key: string,
  state: SubjectState | null,
  what: string,
  count?: number,
): { rows: ConfigChange[]; gap?: string } {
  if (!state) return { rows: asChanges(read.value) }
  if (read.status !== 'ok')
    return { rows: [], gap: `${what} file ${read.status}: red flags may be missing` }
  const f = read.value as ChangesFile | null
  if (
    !f ||
    f.version !== 1 ||
    f.subject !== key ||
    !Array.isArray(f.changes) ||
    f.asOf?.block !== state.asOf.block
  )
    return { rows: [], gap: `${what} file does not match the head state: red flags may be missing` }
  if (count !== undefined && f.changes.length !== count)
    return {
      rows: f.changes,
      gap: `${what} file holds ${f.changes.length} rows, the head state counted ${count}: red flags may be missing`,
    }
  return { rows: f.changes }
}

let eidMemo: { key: string; names: Record<string, string> } | null = null

function eidNames(dir: string): Record<string, string> {
  const path = join(dir, 'lz-metadata.json')
  const key = `${path}|${mtime(path)}`
  if (eidMemo?.key === key) return eidMemo.names
  const raw = readJson(path) as { eids?: Record<string, { name?: string }> } | null
  const names: Record<string, string> = {}
  for (const [eid, v] of Object.entries(raw?.eids ?? {})) if (v?.name) names[eid] = v.name
  eidMemo = { key, names }
  return names
}

function oracleEntries(subject: ConfigSubject): number {
  if (!subject.oracleAssetKey) return 0
  try {
    return getOracleCatalog().entries.filter((e) => e.asset === subject.oracleAssetKey).length
  } catch {
    return 0
  }
}

const inputsMemo = new Map<string, { key: string; inputs: ConfigInputs }>()

export function loadConfigInputs(subject: ConfigSubject, dir = configDir()): ConfigInputs {
  const paths = ['state', 'changes', 'queues'].map((d) => join(dir, d, `${subject.key}.json`))
  const key = paths.map(mtime).join('|')
  const hit = inputsMemo.get(`${dir}|${subject.key}`)
  if (hit?.key === key) return hit.inputs
  const state = asState(readJson(paths[0]), subject.key)
  const ch = checkedRows(
    readJsonStatus(paths[1]),
    subject.key,
    state,
    'change history',
    state?.counts?.historical,
  )
  const qu = checkedRows(readJsonStatus(paths[2]), subject.key, state, 'queue')
  const fileGaps = [ch.gap, qu.gap].filter((g): g is string => !!g)
  // the reds the state recorded that the rows read here cannot show: still counted (fail closed)
  const shownRed = [...ch.rows, ...qu.rows].filter((c) => c.red).length
  const carriedRed = fileGaps.length && state ? Math.max(0, (state.counts?.red ?? 0) - shownRed) : 0
  const inputs: ConfigInputs = {
    subject,
    state,
    changes: ch.rows,
    queue: qu.rows,
    eidNames: eidNames(dir),
    oracleEntries: oracleEntries(subject),
    ...(fileGaps.length ? { fileGaps } : {}),
    ...(carriedRed ? { carriedRed } : {}),
  }
  inputsMemo.set(`${dir}|${subject.key}`, { key, inputs })
  return inputs
}

function subjectsOrEmpty(): ConfigSubject[] {
  try {
    return getConfigSubjects().subjects
  } catch {
    return []
  }
}

/** The subject whose tab slug, subject key or oracle asset key matches (case-insensitive). */
export function findConfigSubject(slug: string): ConfigSubject | null {
  const s = slug.toLowerCase()
  return (
    subjectsOrEmpty().find(
      (x) =>
        subjectSlug(x) === s || x.key.toLowerCase() === s || x.oracleAssetKey?.toLowerCase() === s,
    ) ?? null
  )
}

export function getConfigIndex(dir = configDir()): ConfigIndexResponse {
  const subjects: ConfigTabSummary[] = []
  for (const s of subjectsOrEmpty()) subjects.push(buildConfigSummary(loadConfigInputs(s, dir)))
  return { available: subjects.some((s) => s.asOf != null), subjects }
}

export function getConfigCard(
  slug: string,
  opt: BuildCardOptions = {},
  dir = configDir(),
): ConfigCardView | null {
  const s = findConfigSubject(slug)
  return s ? buildConfigCard(loadConfigInputs(s, dir), opt) : null
}
