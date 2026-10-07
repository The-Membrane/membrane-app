/**
 * Seed catalog: leaves the engine analyses in addition to whatever it discovers from
 * the lending venues, plus per-leaf hints the auto-discovery cannot infer (a Curve
 * pool's priced coin pair, a volatility class for a pull feed).
 *
 * The engine discovers most leaves by decoding every lending market's oracle, so the
 * seed is small. It carries:
 *  - Membrane's own collateral-oracle leaves, so a leaf with zero external readers is
 *    still reported (its EV is then intra-Membrane only; v1 does not yet read the
 *    Membrane Cdp positions, noted as a gap).
 *  - the PT-reUSD methodology fixture leaf, so the fork test can target it by id.
 *  - hints: curvePair (coin indices), volClass / pullStalenessSec for pull feeds.
 *
 * If the oracle-registry team publishes data/oracle-registry/catalog.json, the loader
 * (loadCatalog) merges its entries on top of this seed. This module never writes or
 * imports lib/oracleRegistry/config/* (owned by another workstream).
 */

import type { LeafKind } from '../types'

export interface SeedEntry {
  /** Leaf address (lowercased). */
  address: string
  kind: LeafKind
  label: string
  /** Hint: a Curve pool's priced coin pair. */
  curvePair?: { i: number; j: number }
  /** Hint: volatility class / staleness for a pull feed's free move. */
  volClass?: 'stable' | 'lst' | 'major' | 'alt'
  pullStalenessSec?: number
  /** Where this leaf is used, for the card when auto-discovery finds no external reader. */
  usedBy?: string[]
  note?: string
}

/** The methodology fixtures and known-interesting leaves (mainnet). */
export const SEED_CATALOG: SeedEntry[] = [
  {
    address: '0x13285bcbc27f92b47b4edb99d744c07b48c977c0',
    kind: 'pendle-market',
    label: 'Pendle PT-reUSD-10DEC2026 market',
    usedBy: ['Morpho PT-reUSD/USDC', 'Morpho PT-reUSD/USDT'],
    note: 'August 2026 oracle-manipulation fixture (should read RED).',
  },
]

export interface CatalogEntry extends SeedEntry {
  source: 'seed' | 'registry'
}

/**
 * Merge the seed with the oracle-registry catalog if it exists on disk. The registry
 * file is read-only here; a parse failure or a missing file falls back to the seed.
 */
export function loadCatalog(readJson: (path: string) => unknown | null): CatalogEntry[] {
  const out = new Map<string, CatalogEntry>()
  for (const e of SEED_CATALOG) out.set(e.address.toLowerCase(), { ...e, source: 'seed' })
  const raw = readJson('data/oracle-registry/catalog.json')
  if (raw && typeof raw === 'object') {
    const entries = Array.isArray(raw) ? raw : ((raw as { entries?: unknown[] }).entries ?? [])
    for (const r of entries as Record<string, unknown>[]) {
      const addr = typeof r.leaf === 'string' ? r.leaf : typeof r.address === 'string' ? r.address : null
      if (!addr) continue
      const a = addr.toLowerCase()
      out.set(a, {
        address: a,
        kind: (r.kind as LeafKind) ?? 'unknown',
        label: String(r.label ?? r.name ?? a),
        curvePair: r.curvePair as { i: number; j: number } | undefined,
        volClass: r.volClass as SeedEntry['volClass'],
        pullStalenessSec: typeof r.pullStalenessSec === 'number' ? r.pullStalenessSec : undefined,
        usedBy: Array.isArray(r.usedBy) ? (r.usedBy as string[]) : undefined,
        note: typeof r.note === 'string' ? r.note : undefined,
        source: 'registry',
      })
    }
  }
  return [...out.values()]
}
