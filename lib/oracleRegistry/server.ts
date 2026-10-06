// File loader for the oracle registry's collector output (server only: API routes and
// getServerSideProps). Reads data/oracle-registry/{snapshots,history,changes.json}, builds
// the model once and memoises it until a file changes (the 30-day replay costs ~0.3 s).
//
// Every read is tolerant: a missing or malformed file becomes null / empty, never a throw,
// so a deploy without collector output still serves the catalog's mechanisms.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { getOracleCatalog, type OracleCatalog } from './catalog'
import type { EntryHistory, OracleSnapshot } from './types'
import {
  buildModel,
  type GovernanceFile,
  type HistoryIndexFile,
  type RegistryInputs,
  type RegistryModel,
} from './view'

export const registryDir = (): string => join(process.cwd(), 'data', 'oracle-registry')

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function asSnapshot(raw: unknown): OracleSnapshot | null {
  const s = raw as OracleSnapshot | null
  return s &&
    s.version === 1 &&
    Number.isFinite(s.block) &&
    Number.isFinite(s.ts) &&
    Array.isArray(s.entries)
    ? s
    : null
}

function asHistory(raw: unknown): EntryHistory | null {
  const h = raw as EntryHistory | null
  return h && typeof h.id === 'string' && typeof h.source === 'string' && Array.isArray(h.points)
    ? h
    : null
}

function asHistoryIndex(raw: unknown): HistoryIndexFile | null {
  const i = raw as HistoryIndexFile | null
  return i &&
    i.window &&
    Number.isFinite(i.window.startTs) &&
    Number.isFinite(i.window.endTs) &&
    Array.isArray(i.entries)
    ? i
    : null
}

function asGovernance(raw: unknown): GovernanceFile | null {
  const g = raw as GovernanceFile | null
  return g && g.window && Array.isArray(g.events) ? g : null
}

export function loadRegistryInputs(
  dir = registryDir(),
  catalog: OracleCatalog = getOracleCatalog(),
): RegistryInputs {
  const snapDir = join(dir, 'snapshots')
  const snapshots: OracleSnapshot[] = []
  for (const f of listDir(snapDir).sort()) {
    if (!f.endsWith('.json') || f === 'latest.json') continue
    const s = asSnapshot(readJson(join(snapDir, f)))
    if (s) snapshots.push(s)
  }
  const histDir = join(dir, 'history')
  const histories = new Map<string, EntryHistory>()
  for (const f of listDir(histDir)) {
    if (!f.endsWith('.json') || f === 'index.json') continue
    const h = asHistory(readJson(join(histDir, f)))
    if (h) histories.set(h.id, h)
  }
  return {
    catalog,
    latest: asSnapshot(readJson(join(snapDir, 'latest.json'))),
    snapshots,
    histories,
    historyIndex: asHistoryIndex(readJson(join(histDir, 'index.json'))),
    governance: asGovernance(readJson(join(dir, 'changes.json'))),
  }
}

function mtime(path: string): string {
  try {
    return String(statSync(path).mtimeMs)
  } catch {
    return '-'
  }
}

/** Changes whenever the collector rewrites any file the model reads. */
function fingerprint(dir: string): string {
  return [
    dir,
    mtime(join(dir, 'snapshots', 'latest.json')),
    mtime(join(dir, 'snapshots')),
    mtime(join(dir, 'history')),
    mtime(join(dir, 'history', 'index.json')),
    mtime(join(dir, 'changes.json')),
  ].join('|')
}

let memo: { key: string; model: RegistryModel } | null = null

export function getRegistryModel(dir = registryDir()): RegistryModel {
  const key = fingerprint(dir)
  if (memo?.key === key) return memo.model
  const model = buildModel(loadRegistryInputs(dir))
  memo = { key, model }
  return model
}

/** CDN cache policy: 5 min when data exists, 1 min while the collector has not run. */
export const cacheHeader = (available: boolean): string =>
  available
    ? 'public, s-maxage=300, stale-while-revalidate=600'
    : 'public, s-maxage=60, stale-while-revalidate=60'
