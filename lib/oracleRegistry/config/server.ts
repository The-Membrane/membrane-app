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
  const inputs: ConfigInputs = {
    subject,
    state: asState(readJson(paths[0]), subject.key),
    changes: asChanges(readJson(paths[1])),
    queue: asChanges(readJson(paths[2])),
    eidNames: eidNames(dir),
    oracleEntries: oracleEntries(subject),
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
