/**
 * Hex layout for the wavefront panels. A port of the owner's canvas (board Wavefront.dc.html):
 *
 *   - One hex per liquidated position. A cluster grows from its centre along a hexagonal
 *     spiral (`spiralTo` in the canvas): the k-th position to open in a cluster takes spiral
 *     slot k, so a hex never moves within its cluster once it has appeared.
 *   - Clusters are placed in the order they were first hit, so a new cluster is appended and
 *     never reorders the ones already on screen.
 *   - Pointy-top hexes, side HEX_SIDE (canvas HX_S = 4) and centre spacing HEX_W (canvas
 *     HX_W = 6.93), in layout units; the panel scale (`scale`, px per unit) is capped at
 *     MAX_SCALE = 3 like the canvas, so the first few hexes are not gigantic.
 *
 * Deviation from the canvas: it placed every cluster in a 4-column grid of EQUAL square cells
 * sized for the largest cluster, which leaves a 3 px hex at the end of the Oct 10 replay on a
 * 740 px panel (and ~1.5 px at 390 px). Here each cluster gets a cell of its own size — the
 * cluster's tight hexagonal bounding box with its label on top — and the cells are placed in
 * first-hit order by an in-order skyline (each goes to the lowest spot that fits, so small
 * clusters fill the space beside large ones), at the largest scale that fits the panel.
 * Gaps and labels are in screen px.
 */

export const HEX_SIDE = 4
export const HEX_W = Math.sqrt(3) * HEX_SIDE
const ROW_STEP = 1.5 * HEX_SIDE
export const MAX_SCALE = 3

// ----------------------------------------------------------------- spiral

/** Axial coordinates of the spiral, grown on demand (shared, append-only). */
const SPIRAL_Q: number[] = [0]
const SPIRAL_R: number[] = [0]
/** Running extents of slots 0..k (layout units, hex centres). */
const EXT_MIN_X: number[] = [0]
const EXT_MAX_X: number[] = [0]
const EXT_MIN_Y: number[] = [0]
const EXT_MAX_Y: number[] = [0]
let spiralRing = 0

/** Grow the spiral to at least n slots (the canvas `spiralTo`). */
export function ensureSpiral(n: number): void {
  const dirs = [
    [1, 0],
    [1, -1],
    [0, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
  ]
  while (SPIRAL_Q.length < n) {
    spiralRing++
    let q = -spiralRing
    let r = spiralRing
    for (let d = 0; d < 6; d++) {
      for (let s = 0; s < spiralRing; s++) {
        const k = SPIRAL_Q.length
        SPIRAL_Q.push(q)
        SPIRAL_R.push(r)
        const x = HEX_W * (q + r / 2)
        const y = ROW_STEP * r
        EXT_MIN_X.push(Math.min(EXT_MIN_X[k - 1], x))
        EXT_MAX_X.push(Math.max(EXT_MAX_X[k - 1], x))
        EXT_MIN_Y.push(Math.min(EXT_MIN_Y[k - 1], y))
        EXT_MAX_Y.push(Math.max(EXT_MAX_Y[k - 1], y))
        q += dirs[d][0]
        r += dirs[d][1]
      }
    }
  }
}

/** Offset of spiral slot k from its cluster's origin, in layout units. */
export function slotOffset(k: number): { x: number; y: number } {
  ensureSpiral(k + 1)
  return { x: HEX_W * (SPIRAL_Q[k] + SPIRAL_R[k] / 2), y: ROW_STEP * SPIRAL_R[k] }
}

/** The offsets of slots 0..n-1 (layout units). */
export function slotOffsets(n: number): { xs: Float64Array; ys: Float64Array } {
  ensureSpiral(n)
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    xs[k] = HEX_W * (SPIRAL_Q[k] + SPIRAL_R[k] / 2)
    ys[k] = ROW_STEP * SPIRAL_R[k]
  }
  return { xs, ys }
}

/** The ring that holds the n-th hex (n >= 1): the smallest R with 1 + 3R(R+1) >= n. */
export function ringOf(n: number): number {
  if (n <= 1) return 0
  let r = Math.max(0, Math.floor((Math.sqrt(12 * n - 3) - 3) / 6) - 1)
  while (1 + 3 * r * (r + 1) < n) r++
  return r
}

/**
 * The tight box around a cluster of n hexes, relative to its spiral origin (layout units,
 * hex edges included: ±HEX_W/2 across, ±HEX_SIDE up and down).
 */
export function clusterBox(n: number): { x0: number; x1: number; y0: number; y1: number } {
  if (n <= 0) return { x0: 0, x1: 0, y0: 0, y1: 0 }
  ensureSpiral(n)
  return {
    x0: EXT_MIN_X[n - 1] - HEX_W / 2,
    x1: EXT_MAX_X[n - 1] + HEX_W / 2,
    y0: EXT_MIN_Y[n - 1] - HEX_SIDE,
    y1: EXT_MAX_Y[n - 1] + HEX_SIDE,
  }
}

// ----------------------------------------------------------------- packing

export interface PackOptions {
  /** Panel size, px. */
  width: number
  height: number
  /** Height reserved above each cluster for its label, px (0: no labels). */
  labelPx: number
  /** Label width per cluster, px (a cell is never narrower than its label). */
  labelWidths: readonly number[]
  /** Horizontal and vertical gap between cells, px. */
  gapPx: number
  rowGapPx: number
  maxScale?: number
}

export interface ClusterPlacement {
  /** The cluster's spiral origin (slot 0's centre), px. */
  ox: number
  oy: number
  /** The hexes' box, px. */
  boxX: number
  boxY: number
  boxW: number
  boxH: number
  /** Label box (top-left), px; the label sits right above its cluster. */
  labelX: number
  labelY: number
  labelW: number
  /** The cell (label + cluster), px. */
  cellX: number
  cellY: number
  cellW: number
  cellH: number
}

export interface PanelLayout {
  /** px per layout unit. */
  scale: number
  clusters: ClusterPlacement[]
}

interface Seg {
  x: number
  w: number
  y: number
}

/**
 * Skyline bottom-left placement, in order: each cell goes to the lowest spot where it fits
 * (leftmost on a tie), so the cells already placed never move when a later one is added at
 * the same scale. Returns the cells' top-left corners, or null when one does not fit.
 */
function skyline(
  cells: readonly { w: number; h: number }[],
  W: number,
  H: number,
): { x: number; y: number }[] | null {
  const eps = 1e-9
  let segs: Seg[] = [{ x: 0, w: W, y: 0 }]
  const out: { x: number; y: number }[] = []
  for (const c of cells) {
    let best: { x: number; y: number } | null = null
    for (let i = 0; i < segs.length; i++) {
      const x = segs[i].x
      if (x + c.w > W + eps) break
      let y = 0
      for (let j = i; j < segs.length && segs[j].x < x + c.w - eps; j++) y = Math.max(y, segs[j].y)
      if (y + c.h > H + eps) continue
      if (!best || y < best.y - eps) best = { x, y }
    }
    if (!best) return null
    out.push(best)
    const x0 = best.x
    const x1 = best.x + c.w
    const next: Seg[] = []
    for (const s of segs) {
      const sx1 = s.x + s.w
      if (sx1 <= x0 + eps || s.x >= x1 - eps) {
        next.push(s)
        continue
      }
      if (s.x < x0 - eps) next.push({ x: s.x, w: x0 - s.x, y: s.y })
      if (sx1 > x1 + eps) next.push({ x: x1, w: sx1 - x1, y: s.y })
    }
    next.push({ x: x0, w: c.w, y: best.y + c.h })
    next.sort((a, b) => a.x - b.x)
    segs = []
    for (const s of next) {
      const last = segs[segs.length - 1]
      if (last && Math.abs(last.y - s.y) < eps) last.w += s.w
      else segs.push({ ...s })
    }
  }
  return out
}

/**
 * Place clusters at scale s (px per unit), in the given order. Null when they do not fit.
 * Exposed for the stability test: at a fixed scale, appending a cluster never moves the
 * clusters before it.
 */
export function placeAt(
  counts: readonly number[],
  s: number,
  o: PackOptions,
): ClusterPlacement[] | null {
  const boxes = counts.map(clusterBox)
  const lw = counts.map((_, i) => Math.min(o.labelWidths[i] ?? 0, o.width))
  // Each cell carries its trailing gaps; the panel is grown by one gap to match.
  const cells = boxes.map((b, i) => ({
    w: Math.max(s * (b.x1 - b.x0), lw[i]) + o.gapPx,
    h: o.labelPx + s * (b.y1 - b.y0) + o.rowGapPx,
  }))
  const pos = skyline(cells, o.width + o.gapPx, o.height + o.rowGapPx)
  if (!pos) return null
  // centre the packed block in the panel
  let maxX = 0
  let maxY = 0
  pos.forEach((p, i) => {
    maxX = Math.max(maxX, p.x + cells[i].w - o.gapPx)
    maxY = Math.max(maxY, p.y + cells[i].h - o.rowGapPx)
  })
  const dx = Math.max(0, (o.width - maxX) / 2)
  const dy = Math.max(0, (o.height - maxY) / 2)
  return pos.map((p, i) => {
    const b = boxes[i]
    const cellX = dx + p.x
    const cellY = dy + p.y
    const cellW = cells[i].w - o.gapPx
    const cellH = cells[i].h - o.rowGapPx
    const boxW = s * (b.x1 - b.x0)
    const boxH = s * (b.y1 - b.y0)
    const boxX = cellX + (cellW - boxW) / 2
    const boxY = cellY + o.labelPx
    return {
      ox: boxX - s * b.x0,
      oy: boxY - s * b.y0,
      boxX,
      boxY,
      boxW,
      boxH,
      labelX: cellX + (cellW - lw[i]) / 2,
      labelY: cellY,
      labelW: lw[i],
      cellX,
      cellY,
      cellW,
      cellH,
    }
  })
}

/**
 * Place clusters (given in first-hit order, counts > 0) in the panel. Deterministic: the
 * largest scale (<= maxScale) at which the in-order skyline fits, found by bisection.
 */
export function packClusters(counts: readonly number[], o: PackOptions): PanelLayout {
  const maxScale = o.maxScale ?? MAX_SCALE
  if (counts.length === 0 || o.width <= 0 || o.height <= 0) {
    return { scale: maxScale, clusters: [] }
  }
  const top = placeAt(counts, maxScale, o)
  if (top) return { scale: maxScale, clusters: top }
  let lo = 0
  let hi = maxScale
  let best: ClusterPlacement[] | null = null
  for (let it = 0; it < 26; it++) {
    const mid = (lo + hi) / 2
    const placed = placeAt(counts, mid, o)
    if (placed) {
      lo = mid
      best = placed
    } else {
      hi = mid
    }
  }
  if (best) return { scale: lo, clusters: best }
  // Not even the labels fit: drop the labels' claim on space and shrink to fit.
  const bare = { ...o, labelWidths: counts.map(() => 0) }
  let s = maxScale
  let placed = placeAt(counts, s, bare)
  while (!placed && s > 1e-3) {
    s /= 1.25
    placed = placeAt(counts, s, bare)
  }
  return { scale: s, clusters: placed ?? [] }
}
