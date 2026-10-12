/**
 * Reads The Wire's inputs from the private datasets repo (board rule N18:
 * $MEMBRANE_DATASETS_DIR, else ../membrane-datasets next to the app). Server-only.
 * Each file is re-parsed only when its mtime changes. A missing file leaves its input
 * out: the response then lists the series it would have fed as uncovered.
 */

import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

import { datasetsRoot } from '@/lib/curatorFeed/paths'

import { buildFrames, type WireFrames, type WireInputs } from './series'

export const WIRE_FILES = {
  venueHistory: ['venue-stress', 'history.json'],
  venueSummary: ['venue-stress', 'summary.json'],
  ethUsd: ['price-history', 'eth-usd-1h.json'],
  stethEth: ['price-history', 'steth-eth-1h.json'],
  depeg: ['position-alerts', 'depeg-history.json'],
} as const

type FileKey = keyof typeof WIRE_FILES

const pathOf = (root: string, k: FileKey) => join(root, ...WIRE_FILES[k])

/** Which input files exist under `root`. */
export function wireFilesPresent(root: string = datasetsRoot()): Record<FileKey, boolean> {
  const out = {} as Record<FileKey, boolean>
  for (const k of Object.keys(WIRE_FILES) as FileKey[]) out[k] = existsSync(pathOf(root, k))
  return out
}

let cache: { key: string; frames: WireFrames } | null = null

/** Frames built from the files under `root`, cached on (path, mtime) of every file. */
export function loadWireFrames(root: string = datasetsRoot()): WireFrames {
  const present = wireFilesPresent(root)
  const key = (Object.keys(WIRE_FILES) as FileKey[])
    .map((k) => (present[k] ? `${pathOf(root, k)}@${statSync(pathOf(root, k)).mtimeMs}` : `${k}:-`))
    .join('|')
  if (cache?.key === key) return cache.frames
  const read = <T>(k: FileKey): T | undefined =>
    present[k] ? (JSON.parse(readFileSync(pathOf(root, k), 'utf8')) as T) : undefined
  const history = read<NonNullable<WireInputs['venueStress']>['history']>('venueHistory')
  const summary = read<NonNullable<WireInputs['venueStress']>['summary']>('venueSummary')
  const inputs: WireInputs = {
    venueStress: history && summary ? { history, summary } : undefined,
    ethUsd: read('ethUsd'),
    stethEth: read('stethEth'),
    depeg: read('depeg'),
  }
  cache = { key, frames: buildFrames(inputs) }
  return cache.frames
}
