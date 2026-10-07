/**
 * The curator-feed dataset on disk: public/data/curator-feed/{feed,flows,exposure}.json.
 * Pure (types + JSON shape checks); the collector writes, the API route reads.
 *
 *   feed.json      meta + entities + actions + attribution cases
 *   flows.json     daily reallocation flows (one row per UTC day × vault × target × source)
 *   exposure.json  per-vault allocations at the head block
 * Split so the page's first request (feed) does not carry the flows table.
 */

import type { AttributionCase, Entities, ExposureVault, FeedAction } from './types'

export const SCHEMA = 1

export interface FeedMeta {
  schema: number
  chainId: 1
  fromBlock: number
  toBlock: number
  fromTs: number
  toTs: number
  /** ISO time the collector finished. */
  collectedAt: string
  /** Endpoint labels only (`env:<host>` or a public host) — never a URL. */
  endpoints: string[]
  logs: {
    chunks: number
    rechecked: number
    disagreements: number
    recovered: number
    emptyConfirmed: number
    servedBy: Record<string, number>
    /** Endpoint label → chunks where it returned fewer logs than the second read. */
    shortBy: Record<string, number>
  }
  counts: Record<string, number>
  /** Thresholds the collector used, so the page can state them. */
  thresholds: { largeWithdrawUsd: number; exposureMinUsd: number; keptSupplyDrop: number }
  sources: string[]
  /** Known gaps, in words. */
  caveats: string[]
}

export interface FeedFile {
  meta: FeedMeta
  entities: Entities
  actions: FeedAction[]
  attribution: AttributionCase[]
}
/**
 * Daily flows, dictionary-encoded (≈ 75k rows for 182 days would be ≈ 16 MB as objects).
 * Row = [dayIdx, vaultIdx, targetIdx, source (0 allocator, 1 public allocator), out, in, n];
 * out / in in WHOLE loan-token units, 6 significant digits. Encode/decode: flows.ts.
 */
export type FlowRow = [number, number, number, 0 | 1, number, number, number]
export interface FlowsFile {
  schema: number
  toBlock: number
  days: string[]
  vaults: string[]
  targets: string[]
  rows: FlowRow[]
}
export interface ExposureFile {
  schema: number
  block: number
  ts: number
  vaults: ExposureVault[]
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

// ── interning ──────────────────────────────────────────────────────────────────
// Addresses, market ids and tx hashes repeat tens of thousands of times in feed.json
// (≈ 70% of its bytes before interning). On disk each distinct one is stored once in
// `table`; in the body a reference is `~<base36 index>` (an action id keeps its
// `:<logIndex>` suffix). A real string that starts with `~` is escaped as `~~`.

const HEX = /^0x[0-9a-f]{40}$|^0x[0-9a-f]{64}$/
const ID = /^(0x[0-9a-f]{64}):(\d+)$/
const REF = /^~([0-9a-z]+)(?::(\d+))?$/

export interface Interned {
  table: string[]
  body: unknown
}

const mapStrings = (v: unknown, f: (s: string) => string): unknown => {
  if (typeof v === 'string') return f(v)
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f))
  if (isObj(v)) {
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) o[f(k)] = mapStrings(x, f)
    return o
  }
  return v
}

export function intern(value: unknown): Interned {
  const table: string[] = []
  const idx = new Map<string, number>()
  const ref = (h: string): string => {
    let i = idx.get(h)
    if (i === undefined) {
      i = table.length
      table.push(h)
      idx.set(h, i)
    }
    return '~' + i.toString(36)
  }
  const body = mapStrings(value, (s) => {
    if (HEX.test(s)) return ref(s)
    const m = ID.exec(s)
    if (m) return `${ref(m[1])}:${m[2]}`
    return s.startsWith('~') ? '~' + s : s
  })
  return { table, body }
}

export function unintern(f: Interned): unknown {
  return mapStrings(f.body, (s) => {
    if (!s.startsWith('~')) return s
    if (s.startsWith('~~')) return s.slice(1)
    const m = REF.exec(s)
    if (!m) throw new Error(`intern: malformed reference ${s.slice(0, 20)}`)
    const h = f.table[parseInt(m[1], 36)]
    if (h === undefined) throw new Error(`intern: reference ${m[1]} outside the table`)
    return m[2] !== undefined ? `${h}:${m[2]}` : h
  })
}

/** feed.json on disk: meta in clear, the rest interned. */
export const encodeFeedFile = (feed: FeedFile): unknown => ({
  meta: feed.meta,
  ...intern({ entities: feed.entities, actions: feed.actions, attribution: feed.attribution }),
})

/** Shape check at the boundary; throws with the first problem found. Accepts the
 *  interned on-disk form and the plain form. */
export function parseFeedFile(input: unknown): FeedFile {
  const raw =
    isObj(input) && Array.isArray(input.table) && 'body' in input
      ? { meta: input.meta, ...(unintern(input as unknown as Interned) as object) }
      : input
  if (!isObj(raw) || !isObj(raw.meta)) throw new Error('curator feed: no meta')
  if (raw.meta.schema !== SCHEMA)
    throw new Error(`curator feed: schema ${String(raw.meta.schema)} ≠ ${SCHEMA}`)
  if (!isObj(raw.entities) || !Array.isArray(raw.actions) || !Array.isArray(raw.attribution))
    throw new Error('curator feed: missing entities/actions/attribution')
  for (const a of raw.actions.slice(0, 50)) {
    if (
      !isObj(a) ||
      typeof a.id !== 'string' ||
      typeof a.kind !== 'string' ||
      typeof a.ts !== 'number' ||
      !Array.isArray(a.collateral)
    ) {
      throw new Error('curator feed: malformed action')
    }
  }
  return raw as unknown as FeedFile
}

export function parseExposureFile(raw: unknown): ExposureFile {
  if (!isObj(raw) || raw.schema !== SCHEMA || !Array.isArray(raw.vaults))
    throw new Error('curator exposure: bad file')
  return raw as unknown as ExposureFile
}

export function parseFlowsFile(raw: unknown): FlowsFile {
  if (!isObj(raw) || raw.schema !== SCHEMA || !Array.isArray(raw.rows) || !Array.isArray(raw.days))
    throw new Error('curator flows: bad file')
  return raw as unknown as FlowsFile
}
