// Config-change detector: diff the mechanism parameters of two snapshots into events.
//
// Demand: DeFi Dojo members asked to be alerted when a market's oracle configuration changes
// (linear → TWAP, a TWAP window, a heartbeat). Each snapshot entry carries
//   params — read ON-CHAIN at that block: Chainlink proxy aggregator/phaseId, CAPO snapshot
//            ratio / growth cap, PT discount rate, meta-oracle active leg and thresholds,
//            the lending market's current source (getSourceOfAsset), component wiring,
//            Chronicle bar;
//   config — DECLARED by the catalog: heartbeat, deviation threshold, TWAP window, update
//            model, class, address.
// A value that could not be read (null / missing) is never reported as a change: an RPC
// hiccup is not a governance action. Across a series of snapshots the last value that WAS
// read carries forward over an unreadable one (detectChangeSeries), so A → unreadable → B
// is still one change, dated from the last snapshot that read A.
//
// Pure: compares two snapshot objects.

import type { OracleSnapshot, ParamValue, SnapshotEntry } from './types'

export type ChangeKind =
  | 'aggregator'
  | 'heartbeat'
  | 'deviation_threshold'
  | 'twap_window'
  | 'cap'
  | 'discount'
  | 'market_source'
  | 'wiring'
  | 'quorum'
  | 'update_model'
  | 'entry_added'
  | 'entry_removed'
  | 'other'

export type ChangeEvent = {
  entryId: string
  origin: 'onchain' | 'catalog' | 'entry'
  param: string
  kind: ChangeKind
  from: ParamValue | undefined
  to: ParamValue | undefined
  fromBlock: number
  toBlock: number
  fromTs: number
  toTs: number
}

/** Maps a parameter name onto the alert category a user subscribes to. */
export function classifyParam(param: string): ChangeKind {
  const p = param.toLowerCase()
  if (p.startsWith('source:') || p === 'currentoracle') return 'market_source'
  if (p.startsWith('component:')) return 'wiring'
  if (p === 'aggregator' || p === 'phaseid') return 'aggregator'
  if (p.includes('heartbeat')) return 'heartbeat'
  if (p.includes('deviation')) return 'deviation_threshold'
  if (p.includes('twap') || p.includes('window')) return 'twap_window'
  if (p.includes('discount')) return 'discount'
  if (p.includes('cap') || p.includes('snapshot') || p.includes('growth')) return 'cap'
  if (p === 'bar') return 'quorum'
  if (p === 'updatemodel') return 'update_model'
  if (p === 'address' || p === 'readmethod') return 'wiring'
  return 'other'
}

function same(a: ParamValue, b: ParamValue): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase()
  if (typeof a === 'number' || typeof b === 'number') return String(a) === String(b)
  return a === b
}

function diffMap(
  id: string,
  origin: 'onchain' | 'catalog',
  prev: Record<string, ParamValue> | undefined,
  next: Record<string, ParamValue> | undefined,
  base: Omit<ChangeEvent, 'entryId' | 'origin' | 'param' | 'kind' | 'from' | 'to'>,
): ChangeEvent[] {
  const out: ChangeEvent[] = []
  if (!prev || !next) return out
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)])
  for (const param of [...keys].sort()) {
    const a = prev[param]
    const b = next[param]
    if (a == null || b == null) continue // unreadable on one side ≠ changed
    if (same(a, b)) continue
    out.push({ entryId: id, origin, param, kind: classifyParam(param), from: a, to: b, ...base })
  }
  return out
}

/** Every parameter that differs between two snapshots, plus entries added / removed. */
export function detectChanges(prev: OracleSnapshot, next: OracleSnapshot): ChangeEvent[] {
  const base = { fromBlock: prev.block, toBlock: next.block, fromTs: prev.ts, toTs: next.ts }
  const before = new Map<string, SnapshotEntry>(prev.entries.map((e) => [e.id, e]))
  const after = new Map<string, SnapshotEntry>(next.entries.map((e) => [e.id, e]))
  const out: ChangeEvent[] = []
  for (const [id, b] of after) {
    const a = before.get(id)
    if (!a) {
      out.push({
        entryId: id,
        origin: 'entry',
        param: 'entry',
        kind: 'entry_added',
        from: undefined,
        to: id,
        ...base,
      })
      continue
    }
    out.push(...diffMap(id, 'onchain', a.params, b.params, base))
    out.push(...diffMap(id, 'catalog', a.config, b.config, base))
  }
  for (const id of before.keys()) {
    if (!after.has(id))
      out.push({
        entryId: id,
        origin: 'entry',
        param: 'entry',
        kind: 'entry_removed',
        from: id,
        to: undefined,
        ...base,
      })
  }
  return out
}

/**
 * Every change across a series of snapshots (any order; duplicate blocks collapse). Entry
 * additions and removals compare neighbouring snapshots; parameters compare against the
 * LAST READ value, carried forward over snapshots where it was unreadable, so a change is
 * never lost between two readable snapshots. fromBlock/fromTs is the last snapshot that
 * read the old value: the change happened in (fromTs, toTs].
 */
export function detectChangeSeries(snapshots: readonly OracleSnapshot[]): ChangeEvent[] {
  const chrono = [...snapshots].sort((a, b) => a.block - b.block)
  const unique = chrono.filter((s, i) => i === 0 || s.block !== chrono[i - 1].block)
  const last = new Map<string, { value: ParamValue; block: number; ts: number }>()
  const out: ChangeEvent[] = []
  unique.forEach((snap, i) => {
    const prev = i > 0 ? unique[i - 1] : null
    if (prev) {
      for (const ev of detectChanges(prev, snap)) if (ev.origin === 'entry') out.push(ev) // presence: neighbour to neighbour
    }
    for (const e of snap.entries) {
      for (const [origin, map] of [
        ['onchain', e.params],
        ['catalog', e.config],
      ] as const) {
        if (!map) continue
        for (const param of Object.keys(map).sort()) {
          const value = map[param]
          if (value == null) continue // unreadable: the last read value stands
          const key = `${e.id}\u0000${origin}\u0000${param}`
          const seen = last.get(key)
          if (seen && !same(seen.value, value))
            out.push({
              entryId: e.id,
              origin,
              param,
              kind: classifyParam(param),
              from: seen.value,
              to: value,
              fromBlock: seen.block,
              toBlock: snap.block,
              fromTs: seen.ts,
              toTs: snap.ts,
            })
          last.set(key, { value, block: snap.block, ts: snap.ts })
        }
      }
    }
  })
  return out
}
