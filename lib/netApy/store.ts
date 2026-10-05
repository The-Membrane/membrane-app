/**
 * LOCAL-FIRST STORAGE for net-APY snapshots and the Merkl pull. Server-side only.
 *
 * Neon is quota-limited, so nothing here touches it. Snapshots are small JSON files
 * under `.data/net-apy/` (gitignored; override with NET_APY_STORE_DIR), one per anchor
 * block, pruned to the newest KEEP files so the directory stays a few hundred KB.
 * A read-only filesystem (a serverless deploy) is not an error: writes are skipped and
 * the caller keeps its in-memory copy.
 */

import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

import { bigintReplacer, bigintReviver } from './fixedPoint'
import type { MerklOpportunity } from './incentives'
import type { SnapshotSet } from './read'

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

/** Newest stored set whose anchor block is younger than `maxAgeS` at `nowS`. */
export function loadLatestSnapshotSet(maxAgeS: number, nowS: number = Math.floor(Date.now() / 1000)): SnapshotSet | null {
  const newest = snapshotBlocks()[0]
  if (newest === undefined) return null
  const set = loadSnapshotSetAt(newest)
  if (!set || nowS - Number(set.anchor.blockTimestamp) > maxAgeS) return null
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
