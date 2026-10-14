/**
 * The wavefront hex layout (components/Wavefront/layout.ts + geometry.ts): the hex spiral
 * never puts two hexes of a cluster on top of each other, clusters never overlap, the
 * layout is deterministic, and it is stable as the replay plays — clusters keep their
 * first-hit (reading) order, and a position keeps its cluster and spiral slot.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { decodeCompact, type CompactReplay } from '@/lib/wavefront/stream'
import { BIN_SECONDS, WavefrontTimeline } from '@/components/Wavefront/model'
import {
  HEX_SIDE,
  HEX_W,
  clusterRadius,
  packClusters,
  placeAt,
  ringOf,
  slotOffset,
  slotOffsets,
} from '@/components/Wavefront/layout'
import { panelGeometry } from '@/components/Wavefront/geometry'

const compact: CompactReplay = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../../public/data/oct10-2025/wavefront-replay.json'),
    'utf8',
  ),
)
const timeline = new WavefrontTimeline()
timeline.append(decodeCompact(compact))
const START = compact.window.startTs
const STEPS = compact.window.minutes / 10

/** Panel sizes the page produces: phone (390 px viewport) and the 1600×900 reference. */
const SIZES = [
  { width: 358, height: 358 },
  { width: 752, height: 447 },
  { width: 452, height: 269 },
]

describe('wavefront layout: the hex spiral', () => {
  it('ringOf is the smallest ring holding the n-th hex', () => {
    for (let n = 1; n <= 3000; n++) {
      const r = ringOf(n)
      expect(1 + 3 * r * (r + 1)).toBeGreaterThanOrEqual(n)
      if (r > 0) expect(1 + 3 * (r - 1) * r).toBeLessThan(n)
    }
  })

  it('no two hexes of a cluster overlap, and all sit inside the cluster radius', () => {
    // more than the largest cluster at the end of the replay
    const end = timeline.frameAt(START + STEPS * BIN_SECONDS)
    const N = Math.max(...end.clusters.map((c) => c.count)) + 100
    const { xs, ys } = slotOffsets(N)
    const cell = new Map<string, number[]>()
    const key = (x: number, y: number) => `${Math.floor(x / HEX_W)},${Math.floor(y / HEX_W)}`
    for (let k = 0; k < N; k++) {
      const kx = Math.floor(xs[k] / HEX_W)
      const ky = Math.floor(ys[k] / HEX_W)
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const j of cell.get(`${kx + dx},${ky + dy}`) ?? []) {
            const d = Math.hypot(xs[k] - xs[j], ys[k] - ys[j])
            expect(d).toBeGreaterThanOrEqual(HEX_W - 1e-9)
          }
      const kk = key(xs[k], ys[k])
      cell.set(kk, [...(cell.get(kk) ?? []), k])
      // inside the radius the packer reserves for k+1 hexes
      expect(Math.hypot(xs[k], ys[k]) + HEX_SIDE).toBeLessThanOrEqual(clusterRadius(k + 1) + 1e-9)
    }
  })

  it('a slot never moves as the spiral grows', () => {
    const before = [0, 1, 6, 7, 18, 19, 500].map(slotOffset)
    slotOffsets(5000)
    expect([0, 1, 6, 7, 18, 19, 500].map(slotOffset)).toEqual(before)
  })
})

describe('wavefront layout: cluster packing', () => {
  const frames = [60, 100, 125, 128, 129, 140, STEPS].map((k) =>
    timeline.frameAt(START + k * BIN_SECONDS),
  )

  it('is deterministic', () => {
    for (const f of frames) {
      for (const s of SIZES) {
        const a = panelGeometry(f, s.width, s.height)
        const b = panelGeometry(f, s.width, s.height)
        expect(a.layout).toEqual(b.layout)
        expect(Array.from(a.xs)).toEqual(Array.from(b.xs))
      }
    }
  })

  it('clusters and labels never overlap, and everything stays inside the panel', () => {
    for (const f of frames) {
      for (const s of SIZES) {
        const g = panelGeometry(f, s.width, s.height)
        const cs = g.layout.clusters
        expect(cs).toHaveLength(f.clusters.length)
        for (let i = 0; i < cs.length; i++) {
          const a = cs[i]
          // the cluster and its label sit inside its cell, and the cell inside the panel
          expect(a.cellX).toBeGreaterThanOrEqual(-1e-6)
          expect(a.cellY).toBeGreaterThanOrEqual(-1e-6)
          expect(a.cellX + a.cellW).toBeLessThanOrEqual(s.width + 1e-6)
          expect(a.cellY + a.cellH).toBeLessThanOrEqual(s.height + 1e-6)
          expect(a.x - a.r).toBeGreaterThanOrEqual(a.cellX - 1e-6)
          expect(a.x + a.r).toBeLessThanOrEqual(a.cellX + a.cellW + 1e-6)
          expect(a.labelY).toBeGreaterThanOrEqual(a.cellY - 1e-6)
          expect(a.y + a.r).toBeLessThanOrEqual(a.cellY + a.cellH + 1e-6)
          expect(a.labelX).toBeGreaterThanOrEqual(a.cellX - 1e-6)
          expect(a.labelX + a.labelW).toBeLessThanOrEqual(a.cellX + a.cellW + 1e-6)
          // cells never overlap, so neither do clusters or labels
          for (let j = i + 1; j < cs.length; j++) {
            const b = cs[j]
            const ox = Math.min(a.cellX + a.cellW, b.cellX + b.cellW) - Math.max(a.cellX, b.cellX)
            const oy = Math.min(a.cellY + a.cellH, b.cellY + b.cellH) - Math.max(a.cellY, b.cellY)
            expect(ox <= 1e-6 || oy <= 1e-6, `cells ${i} and ${j} overlap`).toBe(true)
            expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r - 1e-6)
          }
        }
        // every hex inside the panel, and hex width < pitch (no overlap within a cluster)
        for (let i = 0; i < f.n; i++) {
          expect(g.xs[i]).toBeGreaterThanOrEqual(0)
          expect(g.xs[i]).toBeLessThanOrEqual(s.width)
          expect(g.ys[i]).toBeGreaterThanOrEqual(0)
          expect(g.ys[i]).toBeLessThanOrEqual(s.height)
        }
        expect(Math.sqrt(3) * g.rho).toBeLessThan(HEX_W * g.layout.scale)
      }
    }
  })

  it('is stable as clusters appear: order, placement, cluster and slot per position', () => {
    let prevNames: string[] = []
    let prevCounts: number[] = []
    let prev: { cluster: Uint16Array; slot: Uint32Array; n: number } | null = null
    let appeared = 0
    const opts = (s: { width: number; height: number }, texts: string[]) => ({
      width: s.width,
      height: s.height,
      labelPx: 18,
      labelWidths: texts.map((t) => t.length * 6.6 + 8),
      gapPx: 8,
      rowGapPx: 6,
    })
    for (let k = 0; k <= STEPS; k++) {
      const f = timeline.frameAt(START + k * BIN_SECONDS)
      const names = f.clusters.map((c) => c.name)
      // existing clusters keep their order; new ones are appended
      expect(names.slice(0, prevNames.length)).toEqual(prevNames)
      if (names.length > prevNames.length && prevNames.length > 0) {
        // at the new layout's scale, adding the new clusters does not move the old ones
        // (relative to the first cluster: centring shifts the whole block)
        for (const s of SIZES) {
          const counts = f.clusters.map((c) => c.count)
          const texts = names.map((n, i) => `${n} · ${counts[i]}`)
          const scale = packClusters(counts, opts(s, texts)).scale
          const before = placeAt(counts.slice(0, prevNames.length), scale, opts(s, texts))!
          const after = placeAt(counts, scale, opts(s, texts))!
          const rel = (p: typeof after) =>
            p.map((c) => [c.cellX - p[0].cellX, c.cellY - p[0].cellY])
          const a = rel(after).slice(0, before.length).flat()
          rel(before)
            .flat()
            .forEach((v, i) => expect(a[i]).toBeCloseTo(v, 9))
        }
      }
      appeared += names.length - prevNames.length
      // a position keeps its cluster and spiral slot
      if (prev) {
        expect(Array.from(f.cluster.slice(0, prev.n))).toEqual(Array.from(prev.cluster))
        expect(Array.from(f.slot.slice(0, prev.n))).toEqual(Array.from(prev.slot))
      }
      // counts only grow
      prevCounts.forEach((c, i) => expect(f.clusters[i].count).toBeGreaterThanOrEqual(c))
      prevNames = names
      prevCounts = f.clusters.map((c) => c.count)
      prev = { cluster: f.cluster.slice(), slot: f.slot.slice(), n: f.n }
    }
    // every cluster with a walked position appears exactly once
    const clusters = new Set(
      decodeCompact(compact)
        .filter((r) => r.kind === 'open' && r.walked)
        .map((r) => (r.kind === 'open' ? r.cluster : '')),
    )
    expect(appeared).toBe(clusters.size)
  })

  it('packs the end state on a phone at least 1.5× the canvas grid scale', () => {
    const f = timeline.frameAt(START + STEPS * BIN_SECONDS)
    const g = panelGeometry(f, 358, 315)
    expect(Math.sqrt(3) * g.rho).toBeGreaterThan(2.5)
    // the canvas's equal-cell grid would give: cell = 2·maxR + 18 in units, 4 columns
    const biggest = Math.max(...f.clusters.map((c) => c.count))
    const maxR = HEX_W * (Math.sqrt(biggest / 3) + 1.4)
    const canvasScale = Math.min(358 / (4 * (2 * maxR + 18)), 315 / (4 * (2 * maxR + 18)))
    expect(g.layout.scale).toBeGreaterThan(1.5 * canvasScale)
  })

  it('handles an empty panel and a single hex', () => {
    expect(
      packClusters([], {
        width: 300,
        height: 200,
        labelPx: 18,
        labelWidths: [],
        gapPx: 8,
        rowGapPx: 6,
      }).clusters,
    ).toEqual([])
    const one = packClusters([1], {
      width: 300,
      height: 200,
      labelPx: 18,
      labelWidths: [60],
      gapPx: 8,
      rowGapPx: 6,
    })
    expect(one.scale).toBe(3)
    expect(one.clusters[0].x).toBeCloseTo(150)
  })
})
