// Liquidation map — pure helpers over the layered snapshot
// (public/data/liquidation-map/layers.json, built from full-chain scans by
// q26_terminal.py `layers`; aggregates only, no address).

import { BAND_NAMES } from './xrayLogic'

export type Layer = 'price' | 'pair' | 'stable'
export const LAYERS: Layer[] = ['price', 'pair', 'stable']

export type Bands = { debtUsd: number[]; n: number[] }
export type ChainSnapshot = {
  chain: string
  block: number
  readAt: string
  borrowers: number
  near: number
  layers: Record<Layer, Record<string, Bands>>
  totalUsd: Record<Layer, number>
  pairCarryUsd?: Record<string, number>
}
export type LayersDoc = {
  schema: string
  kind: 'measured'
  source: string
  chains: ChainSnapshot[]
  notes: string[]
}

const zero = () => BAND_NAMES.map(() => 0)

/** Debt per layer per band, summed over the selected chains. */
export function layerBands(doc: LayersDoc, chains?: string[]): Record<Layer, number[]> {
  const out = { price: zero(), pair: zero(), stable: zero() } as Record<Layer, number[]>
  for (const c of doc.chains) {
    if (chains && !chains.includes(c.chain)) continue
    for (const L of LAYERS) {
      for (const b of Object.values(c.layers[L] ?? {})) {
        b.debtUsd.forEach((v, i) => (out[L][i] += v))
      }
    }
  }
  return out
}

export type AssetRow = {
  asset: string
  layer: Layer
  debtUsd: number[]
  n: number[]
  total: number
}

/** Top assets across chains (asset x layer), largest total first. */
export function topAssets(doc: LayersDoc, limit = 10, chains?: string[]): AssetRow[] {
  const m = new Map<string, AssetRow>()
  for (const c of doc.chains) {
    if (chains && !chains.includes(c.chain)) continue
    for (const L of LAYERS) {
      for (const [asset, b] of Object.entries(c.layers[L] ?? {})) {
        const k = `${L}:${asset}`
        const row = m.get(k) ?? { asset, layer: L, debtUsd: zero(), n: zero(), total: 0 }
        b.debtUsd.forEach((v, i) => (row.debtUsd[i] += v))
        b.n.forEach((v, i) => (row.n[i] += v))
        row.total = row.debtUsd.reduce((a, x) => a + x, 0)
        m.set(k, row)
      }
    }
  }
  return [...m.values()].sort((a, b) => b.total - a.total).slice(0, limit)
}

/** Debt and positions in one band for one asset and layer on one chain (X-ray crowding). */
export function sameBand(doc: LayersDoc, chain: string, layer: Layer, asset: string, band: number) {
  const b = doc.chains.find((c) => c.chain === chain)?.layers[layer]?.[asset]
  return b ? { debtUsd: b.debtUsd[band], positions: b.n[band] } : null
}

/** Two significant figures in dollars: $3.8B, $27M, $940k. */
export function usd2(v: number): string {
  const a = Math.abs(v)
  const f = (x: number, s: string) => `$${Number(x.toPrecision(2)).toLocaleString('en-US')}${s}`
  if (a >= 1e9) return f(v / 1e9, 'B')
  if (a >= 1e6) return f(v / 1e6, 'M')
  if (a >= 1e3) return f(v / 1e3, 'k')
  return f(v, '')
}
