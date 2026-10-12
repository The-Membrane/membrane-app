/**
 * LOCAL-FIRST STORAGE for net-APY snapshots and the Merkl pull. Server-side only.
 *
 * Neon is quota-limited, so nothing here touches it. Snapshots are small JSON files
 * under `.data/net-apy/` (gitignored; override with NET_APY_STORE_DIR), one per anchor
 * block, pruned to the newest KEEP files so the directory stays a few hundred KB.
 * A read-only filesystem (a serverless deploy) is not an error: writes are skipped and
 * the caller keeps its in-memory copy. Every JSON file is written whole or not at all
 * (temp file + rename), so a crash mid-write never leaves a torn file behind.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'fs'
import { join } from 'path'

import { bigintReplacer, bigintReviver } from './fixedPoint'
import type { NetApyEvent } from './history'
import type { IncentiveCampaign, MerklOpportunity } from './incentives'
import type { SnapshotSet } from './read'
import { asOfOf, type VenueSnapshot } from './types'

export const KEEP_SNAPSHOTS = 48

export const storeDir = (): string => process.env.NET_APY_STORE_DIR || join(process.cwd(), '.data', 'net-apy')

const snapFile = (block: bigint) => `snapshots-${block}.json`
const SNAP_RE = /^snapshots-(\d+)\.json$/

/** Atomic: the body goes to a temp file, renamed over `name` only once complete. */
function writeJson(name: string, body: unknown): boolean {
  const tmp = join(storeDir(), `${name}.tmp-${process.pid}`)
  try {
    mkdirSync(storeDir(), { recursive: true })
    writeFileSync(tmp, JSON.stringify(body, bigintReplacer) + '\n')
    renameSync(tmp, join(storeDir(), name))
    return true
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      // nothing was written
    }
    return false
  }
}

function readJson<T>(name: string): T | null {
  try {
    return JSON.parse(readFileSync(join(storeDir(), name), 'utf8'), bigintReviver) as T
  } catch {
    return null
  }
}

function snapshotBlocks(): bigint[] {
  try {
    return readdirSync(storeDir())
      .map((f) => SNAP_RE.exec(f)?.[1])
      .filter((b): b is string => !!b)
      .map((b) => BigInt(b))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  } catch {
    return []
  }
}

export function saveSnapshotSet(set: SnapshotSet): boolean {
  const ok = writeJson(snapFile(set.anchor.blockNumber), set)
  if (ok) {
    for (const b of snapshotBlocks().slice(KEEP_SNAPSHOTS)) {
      try {
        unlinkSync(join(storeDir(), snapFile(b)))
      } catch {
        // a prune failure only costs disk; never fail the read path for it
      }
    }
  }
  return ok
}

export const loadSnapshotSetAt = (block: bigint): SnapshotSet | null => readJson<SnapshotSet>(snapFile(block))

/**
 * A stored set served as a PINNED replay: its asOf is the block's own time, even when
 * the file was first written by a live read (whose asOf is that read's wall clock).
 */
export function loadPinnedSnapshotSet(block: bigint): SnapshotSet | null {
  const set = loadSnapshotSetAt(block)
  return set && { ...set, asOf: Number(set.anchor.blockTimestamp) }
}

/** Newest stored set read less than `maxAgeS` before `nowS` (its `asOf`, not its finalized anchor's time). */
export function loadLatestSnapshotSet(maxAgeS: number, nowS: number = Math.floor(Date.now() / 1000)): SnapshotSet | null {
  const newest = snapshotBlocks()[0]
  if (newest === undefined) return null
  const set = loadSnapshotSetAt(newest)
  if (!set || nowS - asOfOf(set) > maxAgeS) return null
  return set
}

export interface MerklPull {
  fetchedAt: number
  opportunities: MerklOpportunity[]
}

export const saveMerklPull = (p: MerklPull): boolean => writeJson('merkl-latest.json', p)

export function loadMerklPull(maxAgeS: number, nowS: number = Math.floor(Date.now() / 1000)): MerklPull | null {
  const p = readJson<MerklPull>('merkl-latest.json')
  return p && nowS - p.fetchedAt <= maxAgeS ? p : null
}

// ------------------------------------------------- recorder state (history.ts)

/** The campaigns the last SUCCESSFUL Merkl pull matched — the baseline for the next diff. */
export interface CampaignState {
  observedAt: number
  campaigns: IncentiveCampaign[]
}

export const saveCampaignState = (s: CampaignState): boolean => writeJson('campaigns-latest.json', s)
export const loadCampaignState = (): CampaignState | null => readJson<CampaignState>('campaigns-latest.json')

/**
 * The tick's OWN parameter baseline: the last snapshot the recorder read per venue.
 * Not the newest stored set — API reads store sets too, and diffing against one of
 * those would swallow a change made between two ticks. Merged per venue, so a venue
 * that failed to read keeps its last-known snapshot. Snapshot pruning never touches it.
 */
export interface ParamBaseline {
  observedAt: number
  snapshots: VenueSnapshot[]
}

export const PARAM_BASELINE = 'params-baseline.json'
export const saveParamBaseline = (b: ParamBaseline): boolean => writeJson(PARAM_BASELINE, b)
/** Null when the file is missing OR unreadable; tell them apart with paramBaselineExists. */
export function loadParamBaseline(): ParamBaseline | null {
  const b = readJson<ParamBaseline>(PARAM_BASELINE)
  return b && Array.isArray(b.snapshots) ? b : null
}
export const paramBaselineExists = (): boolean => existsSync(join(storeDir(), PARAM_BASELINE))

// ------------------------------------------------------------------ tick lock

const TICK_LOCK = 'tick.lock'

/** When a lock was taken: the time written in it, else (torn) its mtime; 0 once gone. */
function lockTakenAt(path: string): number {
  try {
    const t = Number(readFileSync(path, 'utf8').split(' ')[0])
    return Number.isFinite(t) && t > 0 ? t : Math.floor(statSync(path).mtimeMs / 1000)
  } catch {
    return 0
  }
}

/**
 * The recorder tick's exclusive lock: manual runs and recorder-tick.sh can overlap.
 * Returns its release, or null while another tick holds a lock younger than `staleS`.
 * An older lock is a crashed tick's and is replaced. A store that cannot be written at
 * all gets a no-op lock: nothing can be recorded there anyway.
 */
export function acquireTickLock(nowS: number, staleS: number): { release: () => void } | null {
  const path = join(storeDir(), TICK_LOCK)
  const token = `${nowS} ${process.pid} ${Math.random().toString(36).slice(2)}`
  // true = taken, false = held by another tick, null = this store cannot be written
  const take = (): boolean | null => {
    try {
      mkdirSync(storeDir(), { recursive: true })
      const fd = openSync(path, 'wx')
      try {
        writeSync(fd, token)
      } finally {
        closeSync(fd)
      }
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EEXIST' ? false : null
    }
  }
  let taken = take()
  if (taken === false) {
    if (nowS - lockTakenAt(path) < staleS) return null
    try {
      unlinkSync(path)
    } catch {
      // released meanwhile
    }
    taken = take()
  }
  if (taken === null) return { release: () => {} }
  if (!taken) return null
  return {
    release: () => {
      try {
        // Only our own: a lock that went stale under us may now be another tick's.
        if (readFileSync(path, 'utf8') === token) unlinkSync(path)
      } catch {
        // already gone
      }
    },
  }
}

/** Append-only change log, one JSON object per line. A quiet tick appends nothing. */
export function appendEvents(events: readonly NetApyEvent[]): boolean {
  if (events.length === 0) return true
  try {
    mkdirSync(storeDir(), { recursive: true })
    appendFileSync(join(storeDir(), 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
    return true
  } catch {
    return false
  }
}

/** Events at or after `sinceS`, oldest first. Unparseable lines are skipped. */
export function loadEvents(sinceS = 0): NetApyEvent[] {
  try {
    return readFileSync(join(storeDir(), 'events.jsonl'), 'utf8')
      .split('\n')
      .flatMap((line) => {
        try {
          const e = JSON.parse(line) as NetApyEvent
          return e.at >= sinceS ? [e] : []
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}
