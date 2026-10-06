/**
 * LOCAL-FIRST STORAGE for net-APY snapshots and the Merkl pull. Server-side only.
 *
 * Neon is quota-limited, so nothing here touches it. Snapshots are small JSON files
 * under `.data/net-apy/` (gitignored; override with NET_APY_STORE_DIR), one per anchor
 * block, pruned to the newest KEEP files so the directory stays a few hundred KB.
 * A read-only filesystem (a serverless deploy) is not an error: writes are skipped and
 * the caller keeps its in-memory copy.
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

import { bigintReplacer, bigintReviver } from './fixedPoint'
import type { NetApyEvent } from './history'
import type { IncentiveCampaign, MerklOpportunity } from './incentives'
import type { SnapshotSet } from './read'
import { asOfOf } from './types'

export const KEEP_SNAPSHOTS = 48

export const storeDir = (): string => process.env.NET_APY_STORE_DIR || join(process.cwd(), '.data', 'net-apy')

const snapFile = (block: bigint) => `snapshots-${block}.json`
const SNAP_RE = /^snapshots-(\d+)\.json$/

function writeJson(name: string, body: unknown): boolean {
  try {
    mkdirSync(storeDir(), { recursive: true })
    writeFileSync(join(storeDir(), name), JSON.stringify(body, bigintReplacer) + '\n')
    return true
  } catch {
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
