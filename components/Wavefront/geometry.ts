/**
 * Panel geometry: where every mark and cluster label goes for one frame at one panel size.
 * Both panels show the same positions, so they share one geometry (the label row is reserved
 * on both; the page prints the labels once, on the Real panel).
 *
 * MINIMUM MARK SIZE. A mark is at least MIN_MARK_PX wide, so its shape (hex / ▲ / ● / ░) is
 * readable, not just its colour (DESIGN_RULES §2). When one mark per position does not fit at
 * that size (a phone), one mark stands for `perHex` positions of the SAME cluster and the page
 * says so ("1 hex = 3 positions"). Within a cluster the marks are then allotted to states by
 * largest remainder (each state gets its share of the cluster's marks, within one) and laid
 * along the spiral oldest sale first, so every cluster's composition is kept; arrival order
 * is not. `perHex` is chosen from the stream's final cluster sizes, so it does not change
 * during play.
 */

import { fmtInt } from './format'
import { HEX_SIDE, packClusters, slotOffsets, type PanelLayout } from './layout'
import { AGE_BUCKETS, CODE_COUNT, MARK, type WavefrontFrame } from './model'

/** JetBrains Mono advances 0.6 em; labels are 11 px. */
export const LABEL_CHAR_PX = 6.6
export const LABEL_LINE_PX = 14
const LABEL_GAP_PX = 4
const LABEL_PAD_PX = 8

/** Smallest mark width, CSS px, at which the shape still reads. */
export const MIN_MARK_PX = 5
/** Positions per mark, tried in order. */
export const PER_HEX_STEPS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50] as const

/** Spiral order of states when marks are aggregated: oldest sale at the centre. */
const SOLD_OLD_FIRST = Array.from(
  { length: AGE_BUCKETS },
  (_, k) => MARK.sold + AGE_BUCKETS - 1 - k,
)
const REAL_ORDER = SOLD_OLD_FIRST
const MEM_ORDER = [...SOLD_OLD_FIRST, MARK.gridEnd, MARK.armed, MARK.pending, MARK.kept]

export interface PanelGeometry {
  /** Mark centres, px. */
  xs: Float32Array
  ys: Float32Array
  /** Mark code per mark, per side (one per position when perHex is 1). */
  real: Uint8Array
  mem: Uint8Array
  /** Hex circumradius, px. */
  rho: number
  /** Mark width, px (√3·rho). */
  markPx: number
  /** Positions per mark. */
  perHex: number
  /** Cluster labels, px. */
  labels: { key: string; text: string; x: number; y: number; w: number }[]
  layout: PanelLayout
}

export const clusterLabel = (name: string, count: number) => `${name} · ${fmtInt(count)}`

/** Hex circumradius for a layout scale: 94% of the pitch like the canvas, ≥ ~0.5 px seam. */
export function rhoAt(scale: number): number {
  const cell = HEX_SIDE * scale
  return Math.max(0.6, Math.min(cell * 0.94, cell - 0.29))
}
export const markPxAt = (scale: number) => Math.sqrt(3) * rhoAt(scale)

function layoutFor(
  clusters: readonly { name: string; count: number }[],
  perHex: number,
  width: number,
  height: number,
): PanelLayout {
  const texts = clusters.map((c) => clusterLabel(c.name, c.count))
  return packClusters(
    clusters.map((c) => Math.ceil(c.count / perHex)),
    {
      width,
      height,
      labelPx: LABEL_LINE_PX + LABEL_GAP_PX,
      labelWidths: texts.map((t) => t.length * LABEL_CHAR_PX + LABEL_PAD_PX),
      gapPx: width < 520 ? 8 : 14,
      rowGapPx: width < 520 ? 6 : 10,
    },
  )
}

/**
 * The fewest positions per mark that keeps marks ≥ MIN_MARK_PX for clusters of these sizes
 * (the stream's final sizes, so the choice holds for every frame before it).
 */
export function choosePerHex(
  clusters: readonly { name: string; count: number }[],
  width: number,
  height: number,
): number {
  if (width <= 0 || height <= 0 || clusters.length === 0) return 1
  for (const n of PER_HEX_STEPS) {
    if (markPxAt(layoutFor(clusters, n, width, height).scale) >= MIN_MARK_PX) return n
  }
  return PER_HEX_STEPS[PER_HEX_STEPS.length - 1]
}

/** Split m marks over the code counts by largest remainder, laid out in `order`. */
function allot(counts: Uint32Array, order: readonly number[], perHex: number, m: number): number[] {
  const base = order.map((code) => Math.floor(counts[code] / perHex))
  const frac = order.map((code, j) => counts[code] / perHex - base[j])
  let rest = m - base.reduce((a, b) => a + b, 0)
  const byFrac = order.map((_, j) => j).sort((a, b) => frac[b] - frac[a] || a - b)
  for (const j of byFrac) {
    if (rest <= 0) break
    if (frac[j] > 0) {
      base[j]++
      rest--
    }
  }
  const out: number[] = []
  order.forEach((code, j) => {
    for (let k = 0; k < base[j]; k++) out.push(code)
  })
  return out
}

export function panelGeometry(
  frame: Pick<WavefrontFrame, 'clusters' | 'n' | 'cluster' | 'slot' | 'real' | 'mem'>,
  width: number,
  height: number,
  perHex = 1,
): PanelGeometry {
  const layout = layoutFor(frame.clusters, perHex, width, height)
  const s = layout.scale
  const where = new Map<number, number>()
  frame.clusters.forEach((c, i) => where.set(c.index, i))
  const rho = rhoAt(s)
  const labels = layout.clusters.map((p, i) => ({
    key: frame.clusters[i].name,
    text: clusterLabel(frame.clusters[i].name, frame.clusters[i].count),
    x: p.labelX,
    y: p.labelY,
    w: p.labelW,
  }))
  const marksPer = frame.clusters.map((c) => Math.ceil(c.count / perHex))
  const total = marksPer.reduce((a, b) => a + b, 0)
  const { xs: ox, ys: oy } = slotOffsets(Math.max(0, ...marksPer))
  const xs = new Float32Array(total)
  const ys = new Float32Array(total)
  const base = { rho, markPx: Math.sqrt(3) * rho, perHex, labels, layout }
  if (perHex === 1) {
    // one mark per position, at its own spiral slot, in arrival order
    for (let i = 0; i < frame.n; i++) {
      const p = layout.clusters[where.get(frame.cluster[i])!]
      const k = frame.slot[i]
      xs[i] = p.ox + s * ox[k]
      ys[i] = p.oy + s * oy[k]
    }
    return { ...base, xs, ys, real: frame.real, mem: frame.mem }
  }
  // aggregated: per cluster, count codes per side, then allot that cluster's marks
  const realCounts = frame.clusters.map(() => new Uint32Array(CODE_COUNT))
  const memCounts = frame.clusters.map(() => new Uint32Array(CODE_COUNT))
  for (let i = 0; i < frame.n; i++) {
    const ci = where.get(frame.cluster[i])!
    realCounts[ci][frame.real[i]]++
    memCounts[ci][frame.mem[i]]++
  }
  const real = new Uint8Array(total)
  const mem = new Uint8Array(total)
  let at = 0
  frame.clusters.forEach((_, ci) => {
    const m = marksPer[ci]
    const r = allot(realCounts[ci], REAL_ORDER, perHex, m)
    const mm = allot(memCounts[ci], MEM_ORDER, perHex, m)
    const p = layout.clusters[ci]
    for (let k = 0; k < m; k++) {
      xs[at] = p.ox + s * ox[k]
      ys[at] = p.oy + s * oy[k]
      real[at] = r[k]
      mem[at] = mm[k]
      at++
    }
  })
  return { ...base, xs, ys, real, mem }
}
