/**
 * Panel geometry: where every hex and cluster label goes for one frame at one panel size.
 * Both panels show the same positions, so they share one geometry.
 */

import { fmtInt } from './format'
import { HEX_SIDE, packClusters, slotOffsets, type PanelLayout } from './layout'
import type { WavefrontFrame } from './model'

/** JetBrains Mono advances 0.6 em; labels are 11 px. */
export const LABEL_CHAR_PX = 6.6
export const LABEL_LINE_PX = 14
const LABEL_GAP_PX = 4
const LABEL_PAD_PX = 8

export interface PanelGeometry {
  /** Hex centres, px, per position in open order. */
  xs: Float32Array
  ys: Float32Array
  /** Hex circumradius, px. */
  rho: number
  /** Cluster labels, px. */
  labels: { key: string; text: string; x: number; y: number; w: number }[]
  layout: PanelLayout
}

export const clusterLabel = (name: string, count: number) => `${name} · ${fmtInt(count)}`

export function panelGeometry(
  frame: Pick<WavefrontFrame, 'clusters' | 'n' | 'cluster' | 'slot'>,
  width: number,
  height: number,
): PanelGeometry {
  const texts = frame.clusters.map((c) => clusterLabel(c.name, c.count))
  const layout = packClusters(
    frame.clusters.map((c) => c.count),
    {
      width,
      height,
      labelPx: LABEL_LINE_PX + LABEL_GAP_PX,
      labelWidths: texts.map((t) => t.length * LABEL_CHAR_PX + LABEL_PAD_PX),
      gapPx: width < 520 ? 8 : 14,
      rowGapPx: width < 520 ? 6 : 10,
    },
  )
  const s = layout.scale
  const where = new Map<number, number>()
  frame.clusters.forEach((c, i) => where.set(c.index, i))
  const maxCount = frame.clusters.reduce((m, c) => Math.max(m, c.count), 0)
  const { xs: ox, ys: oy } = slotOffsets(maxCount)
  const xs = new Float32Array(frame.n)
  const ys = new Float32Array(frame.n)
  for (let i = 0; i < frame.n; i++) {
    const p = layout.clusters[where.get(frame.cluster[i])!]
    const k = frame.slot[i]
    xs[i] = p.x + s * ox[k]
    ys[i] = p.y + s * oy[k]
  }
  // The canvas drew 6.5 px hexes on a 6.93 px pitch (94%); keep at least a ~0.5 px seam.
  const cell = HEX_SIDE * s
  const rho = Math.max(0.6, Math.min(cell * 0.94, cell - 0.29))
  const labels = layout.clusters.map((p, i) => ({
    key: frame.clusters[i].name,
    text: texts[i],
    x: p.labelX,
    y: p.labelY,
    w: p.labelW,
  }))
  return { xs, ys, rho, labels, layout }
}
