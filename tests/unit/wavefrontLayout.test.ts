/**
 * The wavefront hex layout (components/Wavefront/layout.ts + geometry.ts): the hex spiral
 * never puts two hexes of a cluster on top of each other, every hex sits inside its cluster's
 * box and every box inside its own cell, cells never overlap, the layout is deterministic and
 * stable as the replay plays, marks are never narrower than MIN_MARK_PX at the sizes the page
 * produces, and an aggregated panel keeps each cluster's composition.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { decodeCompact, type CompactReplay } from '@/lib/wavefront/stream'
import { BIN_SECONDS, CODE_COUNT, WavefrontTimeline } from '@/components/Wavefront/model'
import {
  HEX_SIDE,
  HEX_W,
  clusterBox,
  packClusters,
  placeAt,
  ringOf,
  slotOffset,
  slotOffsets,
} from '@/components/Wavefront/layout'
import {
  MIN_MARK_PX,
  choosePerHex,
  panelGeometry,
  type PanelGeometry,
} from '@/components/Wavefront/geometry'

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
const END_FRAME = timeline.frameAt(START + STEPS * BIN_SECONDS)
const FINAL = timeline
  .clusterTotals()
  .map((count, i) => ({ name: timeline.clusterNames[i], count }))

/**
 * Panel sizes the page produces (1.2:1 below 992 px, 740:440 above): a 390 px phone, a 375 px
 * phone, 600 px and 768 px tablets two-up, and the 1600×900 reference.
 */
const SIZES = [
  { name: 'phone-390', width: 358, height: 298 },
  { name: 'phone-375', width: 343, height: 286 },
  { name: 'tablet-600', width: 272, height: 227 },
  { name: 'tablet-768', width: 348, height: 290 },
  { name: 'desktop-1600', width: 752, height: 447 },
]

const geomAt = (k: number, s: { width: number; height: number }): PanelGeometry => {
  const f = timeline.frameAt(START + k * BIN_SECONDS)
  return panelGeometry(f, s.width, s.height, choosePerHex(FINAL, s.width, s.height))
}

describe('wavefront layout: the hex spiral', () => {
  it('ringOf is the smallest ring holding the n-th hex', () => {
    for (let n = 1; n <= 3000; n++) {
      const r = ringOf(n)
      expect(1 + 3 * r * (r + 1)).toBeGreaterThanOrEqual(n)
      if (r > 0) expect(1 + 3 * (r - 1) * r).toBeLessThan(n)
    }
  })

  it('no two hexes of a cluster overlap, and every hex sits inside the cluster box', () => {
    // more than the largest cluster at the end of the replay
    const N = Math.max(...END_FRAME.clusters.map((c) => c.count)) + 100
    const { xs, ys } = slotOffsets(N)
    const cell = new Map<string, number[]>()
    for (let k = 0; k < N; k++) {
      const kx = Math.floor(xs[k] / HEX_W)
      const ky = Math.floor(ys[k] / HEX_W)
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const j of cell.get(`${kx + dx},${ky + dy}`) ?? []) {
            expect(Math.hypot(xs[k] - xs[j], ys[k] - ys[j])).toBeGreaterThanOrEqual(HEX_W - 1e-9)
          }
      cell.set(`${kx},${ky}`, [...(cell.get(`${kx},${ky}`) ?? []), k])
    }
    for (const n of [1, 2, 7, 8, 19, 20, 100, 1000, N]) {
      const b = clusterBox(n)
      for (let k = 0; k < n; k++) {
        expect(xs[k] - HEX_W / 2).toBeGreaterThanOrEqual(b.x0 - 1e-9)
        expect(xs[k] + HEX_W / 2).toBeLessThanOrEqual(b.x1 + 1e-9)
        expect(ys[k] - HEX_SIDE).toBeGreaterThanOrEqual(b.y0 - 1e-9)
        expect(ys[k] + HEX_SIDE).toBeLessThanOrEqual(b.y1 + 1e-9)
      }
    }
  })

  it('a slot never moves as the spiral grows', () => {
    const before = [0, 1, 6, 7, 18, 19, 500].map(slotOffset)
    slotOffsets(5000)
    expect([0, 1, 6, 7, 18, 19, 500].map(slotOffset)).toEqual(before)
  })
})

describe('wavefront layout: cluster packing', () => {
  const STEPS_TO_CHECK = [60, 100, 125, 128, 129, 140, STEPS]

  it('is deterministic', () => {
    for (const k of STEPS_TO_CHECK) {
      for (const s of SIZES) {
        const a = geomAt(k, s)
        const b = geomAt(k, s)
        expect(a.layout).toEqual(b.layout)
        expect(Array.from(a.xs)).toEqual(Array.from(b.xs))
        expect(Array.from(a.mem)).toEqual(Array.from(b.mem))
      }
    }
  })

  it('cells never overlap; boxes, labels and marks stay in their cell and the panel', () => {
    for (const k of STEPS_TO_CHECK) {
      for (const s of SIZES) {
        const g = geomAt(k, s)
        const cs = g.layout.clusters
        const eps = 1e-6
        for (let i = 0; i < cs.length; i++) {
          const a = cs[i]
          expect(a.cellX).toBeGreaterThanOrEqual(-eps)
          expect(a.cellY).toBeGreaterThanOrEqual(-eps)
          expect(a.cellX + a.cellW).toBeLessThanOrEqual(s.width + eps)
          expect(a.cellY + a.cellH).toBeLessThanOrEqual(s.height + eps)
          expect(a.boxX).toBeGreaterThanOrEqual(a.cellX - eps)
          expect(a.boxX + a.boxW).toBeLessThanOrEqual(a.cellX + a.cellW + eps)
          expect(a.boxY + a.boxH).toBeLessThanOrEqual(a.cellY + a.cellH + eps)
          expect(a.labelY).toBeGreaterThanOrEqual(a.cellY - eps)
          expect(a.labelX).toBeGreaterThanOrEqual(a.cellX - eps)
          expect(a.labelX + a.labelW).toBeLessThanOrEqual(a.cellX + a.cellW + eps)
          for (let j = i + 1; j < cs.length; j++) {
            const b = cs[j]
            const ox = Math.min(a.cellX + a.cellW, b.cellX + b.cellW) - Math.max(a.cellX, b.cellX)
            const oy = Math.min(a.cellY + a.cellH, b.cellY + b.cellH) - Math.max(a.cellY, b.cellY)
            expect(ox <= eps || oy <= eps, `${s.name} k=${k}: cells ${i} and ${j}`).toBe(true)
          }
        }
        // every mark inside the panel; hex width < pitch (no overlap within a cluster)
        for (let i = 0; i < g.xs.length; i++) {
          expect(g.xs[i]).toBeGreaterThanOrEqual(0)
          expect(g.xs[i]).toBeLessThanOrEqual(s.width)
          expect(g.ys[i]).toBeGreaterThanOrEqual(0)
          expect(g.ys[i]).toBeLessThanOrEqual(s.height)
        }
        expect(Math.sqrt(3) * g.rho).toBeLessThan(HEX_W * g.layout.scale)
      }
    }
  })

  it(`marks are at least ${MIN_MARK_PX} px wide at every size the page produces, all replay long`, () => {
    for (const s of SIZES) {
      const perHex = choosePerHex(FINAL, s.width, s.height)
      let min = Infinity
      for (let k = 1; k <= STEPS; k += 1) {
        const f = timeline.frameAt(START + k * BIN_SECONDS)
        const g = panelGeometry(f, s.width, s.height, perHex)
        if (g.xs.length) min = Math.min(min, g.markPx)
      }
      expect(min, `${s.name}: ${perHex} per hex`).toBeGreaterThanOrEqual(MIN_MARK_PX)
    }
    // desktop keeps one hex per position
    expect(choosePerHex(FINAL, 752, 447)).toBe(1)
  })

  it('an aggregated panel keeps every cluster`s composition (within one mark per state)', () => {
    const s = SIZES[0]
    const perHex = choosePerHex(FINAL, s.width, s.height)
    expect(perHex).toBeGreaterThan(1)
    for (const k of [125, 129, STEPS]) {
      const f = timeline.frameAt(START + k * BIN_SECONDS)
      const g = panelGeometry(f, s.width, s.height, perHex)
      // marks per cluster = ceil(count / perHex), on both sides
      expect(g.xs.length).toBe(f.clusters.reduce((a, c) => a + Math.ceil(c.count / perHex), 0))
      expect(g.real.length).toBe(g.xs.length)
      expect(g.mem.length).toBe(g.xs.length)
      // per cluster and state, marks = positions / perHex, within one
      const byCluster = new Map<number, number>()
      f.clusters.forEach((c, i) => byCluster.set(c.index, i))
      const pos = f.clusters.map(() => new Array(CODE_COUNT).fill(0))
      for (let i = 0; i < f.n; i++) pos[byCluster.get(f.cluster[i])!][f.mem[i]]++
      let at = 0
      f.clusters.forEach((c, ci) => {
        const m = Math.ceil(c.count / perHex)
        const marks = new Array(CODE_COUNT).fill(0)
        for (let j = 0; j < m; j++) marks[g.mem[at + j]]++
        at += m
        for (let code = 0; code < CODE_COUNT; code++) {
          expect(Math.abs(marks[code] - pos[ci][code] / perHex)).toBeLessThan(1)
        }
      })
    }
  })

  it('is stable as clusters appear: order, placement, cluster and slot per position', () => {
    let prevNames: string[] = []
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
      if (prev) {
        expect(Array.from(f.cluster.slice(0, prev.n))).toEqual(Array.from(prev.cluster))
        expect(Array.from(f.slot.slice(0, prev.n))).toEqual(Array.from(prev.slot))
      }
      prevNames = names
      prev = { cluster: f.cluster.slice(), slot: f.slot.slice(), n: f.n }
    }
    expect(appeared).toBe(FINAL.length)
  })

  it('packs the end state at least 1.5× the canvas grid scale on a phone (one hex each)', () => {
    const g = panelGeometry(END_FRAME, 358, 298, 1)
    const biggest = Math.max(...END_FRAME.clusters.map((c) => c.count))
    const maxR = HEX_W * (Math.sqrt(biggest / 3) + 1.4)
    const canvasScale = Math.min(358 / (4 * (2 * maxR + 18)), 298 / (4 * (2 * maxR + 18)))
    expect(g.layout.scale).toBeGreaterThan(1.5 * canvasScale)
  })

  it('handles an empty panel and a single hex', () => {
    const o = { width: 300, height: 200, labelPx: 18, gapPx: 8, rowGapPx: 6 }
    expect(packClusters([], { ...o, labelWidths: [] }).clusters).toEqual([])
    const one = packClusters([1], { ...o, labelWidths: [60] })
    expect(one.scale).toBe(3)
    expect(one.clusters[0].ox).toBeCloseTo(150)
  })
})
