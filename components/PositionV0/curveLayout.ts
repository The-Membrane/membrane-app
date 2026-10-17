// THE CURVE'S MARKS, LAID OUT. Owner, 2026-10-16: the lever dots stacked on the line's ring
// and on each other, so a repay point could not be told from the line. This module is pure
// geometry, with no React, so tests/unit/positionCurveLayout.test.ts covers coincident points.
//
//   - The reader's ring never moves. It is the point the chart is about.
//   - A lever point carries one marker per lever kind, side by side: ■ repay, ◆ add.
//   - A marker group sits on its point when that spot is clear. Otherwise it moves to the
//     nearest clear spot that leaves the point uncovered. A leader runs back to the point,
//     and the point keeps a small dot.
//   - Every label sits beside its own marker. No label shares a lane with another. Where it
//     can, a label keeps off the curve line, and the reader's label keeps off the levers' points.
//   - No two footprints overlap: the ring, a marker group, a label or a moved point's dot.
//     Labels and moved groups stay inside the bounds.

export type LeverKind = 'repay' | 'add'

/** Order of the markers inside a group, and of the legend. */
export const LEVER_KINDS: readonly LeverKind[] = ['repay', 'add']

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const MARK = {
  /** The reader's ring: radius and stroke. */
  ringR: 7,
  ringStroke: 2,
  /** One lever marker's square footprint: ■ is 8px, ◆ is 10px tip to tip. */
  lever: 10,
  /** Between two markers of one group. */
  leverGap: 3,
  /** Between a ring or marker group and its own label. */
  labelGap: 4,
  /** Clearance kept between any two footprints. */
  pad: 2,
  /** The dot a moved group leaves on its point. */
  dotR: 2,
} as const

export interface LayoutInput {
  /** Where labels and moved groups may go: the plot area. */
  bounds: Rect
  you: { x: number; y: number; label: string } | null
  /** Lever points in drawing order (nearest the reader first). */
  levers: { id: string; x: number; y: number; kinds: LeverKind[]; label: string }[]
  /** Footprints already drawn that nothing may cover, e.g. the reader's drop to the axis. */
  obstacles?: Rect[]
  /** The curve line, as drawn. Labels prefer spots that do not cross it. */
  curve?: { x: number; y: number }[]
  /** The drawing's edge. A group left on its point must still fit inside it. */
  outer?: Rect
  /** One label character's advance and the label's line box, in px (mono 11px: 6.6 and 12). */
  charW: number
  lineH: number
}

export interface PlacedLabel {
  /** The SVG text anchor point: x at the anchored edge, y at the baseline. */
  x: number
  y: number
  anchor: 'start' | 'middle' | 'end'
  box: Rect
}

export interface PlacedYou {
  x: number
  y: number
  /** The ring's footprint, stroke included. */
  ring: Rect
  label: PlacedLabel
}

export interface PlacedLever {
  id: string
  /** The point on the curve the lever reaches. */
  point: { x: number; y: number }
  /** Marker centres, one per kind, in LEVER_KINDS order. */
  markers: { kind: LeverKind; x: number; y: number }[]
  /** The group's footprint. */
  box: Rect
  label: PlacedLabel
  /** True when the group sits off its point. The leader then runs from the group to the point. */
  moved: boolean
  leader: { x1: number; y1: number; x2: number; y2: number } | null
  /** Draw the point's dot: the group moved and nothing else (the ring) already covers the point. */
  dot: boolean
}

export interface CurveLayout {
  you: PlacedYou | null
  levers: PlacedLever[]
}

/** True when a and b come closer than `pad`. */
export function overlaps(a: Rect, b: Rect, pad = 0): boolean {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad
}

const EPS = 1e-6
export const inside = (a: Rect, b: Rect): boolean =>
  a.x >= b.x - EPS && a.y >= b.y - EPS && a.x + a.w <= b.x + b.w + EPS && a.y + a.h <= b.y + b.h + EPS

const contains = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h

const square = (cx: number, cy: number, half: number): Rect => ({ x: cx - half, y: cy - half, w: half * 2, h: half * 2 })

/**
 * The label's box on one side of `anchor`, with its text anchor point. Along the other axis
 * it slides into the bounds, so a ring at the top of the plot keeps its label beside it.
 */
function labelAt(anchor: Rect, spot: LabelSpot, w: number, h: number, bounds: Rect): PlacedLabel {
  const g = MARK.labelGap
  const [side, lift] = spot
  const slide = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
  // A raised or lowered side spot moves the label's centre half a line plus 2px off the
  // anchor's centre line: still beside the mark, clear of a curve that runs through it.
  const off = lift === 'up' ? -(h / 2 + 2) : lift === 'down' ? h / 2 + 2 : 0
  const cy = slide(anchor.y + anchor.h / 2 + off, bounds.y + h / 2, bounds.y + bounds.h - h / 2)
  const cx = slide(anchor.x + anchor.w / 2, bounds.x + w / 2, bounds.x + bounds.w - w / 2)
  // Mono caps and figures sit about three quarters down their line box.
  const base = (top: number) => top + h * 0.75
  switch (side) {
    case 'right': {
      const box = { x: anchor.x + anchor.w + g, y: cy - h / 2, w, h }
      return { x: box.x, y: base(box.y), anchor: 'start', box }
    }
    case 'left': {
      const box = { x: anchor.x - g - w, y: cy - h / 2, w, h }
      return { x: box.x + w, y: base(box.y), anchor: 'end', box }
    }
    case 'above': {
      const box = { x: cx - w / 2, y: anchor.y - g - h, w, h }
      return { x: cx, y: base(box.y), anchor: 'middle', box }
    }
    case 'below': {
      const box = { x: cx - w / 2, y: anchor.y + anchor.h + g, w, h }
      return { x: cx, y: base(box.y), anchor: 'middle', box }
    }
  }
}

type LabelSpot = readonly ['right' | 'left' | 'above' | 'below', 'up' | 'down' | null]

/** Label spots in order of preference. The curve falls to the right, so right and raised-right
 *  sit above it, and left and lowered-left sit under it. */
const LABEL_SPOTS: readonly LabelSpot[] = [
  ['right', null],
  ['right', 'up'],
  ['left', null],
  ['left', 'down'],
  ['above', null],
  ['below', null],
  ['right', 'down'],
  ['left', 'up'],
]

/** Does segment a–b pass through r (Liang–Barsky)? */
function segmentHits(a: { x: number; y: number }, b: { x: number; y: number }, r: Rect): boolean {
  let t0 = 0
  let t1 = 1
  const dx = b.x - a.x
  const dy = b.y - a.y
  const p = [-dx, dx, -dy, dy]
  const q = [a.x - r.x, r.x + r.w - a.x, a.y - r.y, r.y + r.h - a.y]
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false
    } else {
      const t = q[i] / p[i]
      if (p[i] < 0) {
        if (t > t1) return false
        if (t > t0) t0 = t
      } else {
        if (t < t0) return false
        if (t < t1) t1 = t
      }
    }
  }
  return true
}

/** Offsets tried, nearest first, before the full scan: up, up-right and right lead, since the
 *  curve falls to the right and leaves that side clear. */
const DIRS: readonly [number, number][] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [-1, -1],
  [0, 1],
  [1, 1],
  [-1, 0],
  [-1, 1],
]
const RINGS = [12, 16, 20, 24, 30, 36, 44, 52]

/** Every spot a group may try, nearest its point first; the scan guarantees a find if one exists. */
function* candidates(px: number, py: number, bounds: Rect): Generator<[number, number]> {
  yield [px, py]
  for (const d of RINGS) for (const [dx, dy] of DIRS) yield [px + dx * d, py + dy * d]
  const step = 3
  const spots: [number, number, number][] = []
  for (let y = bounds.y; y <= bounds.y + bounds.h; y += step) {
    for (let x = bounds.x; x <= bounds.x + bounds.w; x += step) spots.push([x, y, (x - px) ** 2 + (y - py) ** 2])
  }
  spots.sort((a, b) => a[2] - b[2])
  for (const [x, y] of spots) yield [x, y]
}

/** The nearest point of `r` to (x, y). */
const clampTo = (r: Rect, x: number, y: number) => ({
  x: Math.min(r.x + r.w, Math.max(r.x, x)),
  y: Math.min(r.y + r.h, Math.max(r.y, y)),
})

export function layoutCurveMarks({ bounds, you, levers, obstacles = [], curve = [], outer, charW, lineH }: LayoutInput): CurveLayout {
  const taken: Rect[] = [...obstacles]
  const free = (r: Rect) => taken.every((t) => !overlaps(r, t, MARK.pad))
  const textW = (s: string) => s.length * charW
  // A line that only grazes a label's box does not count: the halo covers it.
  const onCurve = (r: Rect) => {
    const inner = { x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 }
    return curve.some((p, i) => i > 0 && segmentHits(curve[i - 1], p, inner))
  }
  /** The first clear spot that also keeps off the curve (and `avoid`), else the first clear spot. */
  const bestLabel = (anchor: Rect, w: number, ok: (l: PlacedLabel) => boolean, avoid: Rect[] = []) => {
    const options = LABEL_SPOTS.map((spot) => labelAt(anchor, spot, w, lineH, bounds)).filter(ok)
    return options.find((l) => !onCurve(l.box) && avoid.every((r) => !overlaps(l.box, r, MARK.pad))) ?? options[0] ?? null
  }

  const groupSize = (kinds: readonly LeverKind[]) => {
    const n = Math.max(1, LEVER_KINDS.filter((k) => kinds.includes(k)).length)
    return { w: n * MARK.lever + (n - 1) * MARK.leverGap, h: MARK.lever }
  }

  let placedYou: PlacedYou | null = null
  if (you) {
    const ring = square(you.x, you.y, MARK.ringR + MARK.ringStroke / 2)
    taken.push(ring)
    const w = textW(you.label)
    // The levers are not placed yet, but their points are known: the reader's label keeps
    // off them (beside the ring, the curve is often nearly flat and the next lever sits
    // right there). Failing that, any clear spot; the first spot is the last resort.
    const leverSpots = levers.map((lv) => {
      const g = groupSize(lv.kinds)
      return { x: lv.x - g.w / 2, y: lv.y - g.h / 2, w: g.w, h: g.h }
    })
    const label =
      bestLabel(ring, w, (l) => inside(l.box, bounds) && free(l.box), leverSpots) ??
      labelAt(ring, LABEL_SPOTS[0], w, lineH, bounds)
    taken.push(label.box)
    placedYou = { x: you.x, y: you.y, ring, label }
  }

  const placed: PlacedLever[] = []
  for (const lv of levers) {
    const kinds = LEVER_KINDS.filter((k) => lv.kinds.includes(k))
    const { w: gw, h: gh } = groupSize(kinds)
    const labelW = textW(lv.label)
    const dot = square(lv.x, lv.y, MARK.dotR)
    // A point under the ring (or under an earlier group) gets no dot of its own: the leader
    // ends on that footprint, and the group still moves off it. A point merely beside the
    // ring keeps its dot, so the leader never reads as pointing at the ring.
    const dotFree = taken.every((t) => !overlaps(dot, t))

    let found: { box: Rect; label: PlacedLabel; moved: boolean } | null = null
    for (const [cx, cy] of candidates(lv.x, lv.y, bounds)) {
      const box = { x: cx - gw / 2, y: cy - gh / 2, w: gw, h: gh }
      const moved = Math.abs(cx - lv.x) > EPS || Math.abs(cy - lv.y) > EPS
      if (moved) {
        // A moved group must leave its point, and the point's dot, in view.
        if (!inside(box, bounds) || contains(box, lv.x, lv.y) || overlaps(box, dot, MARK.pad) || !free(box)) continue
      } else if (!free(box) || (outer && !inside(box, outer))) {
        continue
      }
      const label = bestLabel(
        box,
        labelW,
        (l) => inside(l.box, bounds) && free(l.box) && !(moved && overlaps(l.box, dot, MARK.pad)),
      )
      if (label) {
        found = { box, label, moved }
        break
      }
    }
    // No clear spot anywhere (a plot too small for its marks): stay on the point.
    if (!found) {
      const box = { x: lv.x - gw / 2, y: lv.y - gh / 2, w: gw, h: gh }
      found = { box, label: labelAt(box, LABEL_SPOTS[0], labelW, lineH, bounds), moved: false }
    }

    const { box, label, moved } = found
    taken.push(box, label.box)
    const showDot = moved && dotFree
    if (showDot) taken.push(dot)
    const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 }
    const step = MARK.lever + MARK.leverGap
    const markers = kinds.map((kind, i) => ({ kind, x: c.x + (i - (kinds.length - 1) / 2) * step, y: c.y }))
    const edge = clampTo(box, lv.x, lv.y)
    placed.push({
      id: lv.id,
      point: { x: lv.x, y: lv.y },
      markers,
      box,
      label,
      moved,
      leader: moved ? { x1: edge.x, y1: edge.y, x2: lv.x, y2: lv.y } : null,
      dot: showDot,
    })
  }
  return { you: placedYou, levers: placed }
}

/** "■ if you repay  ◆ if you add": the legend line's own width, in px, for the kinds shown. */
export function legendWidth(kinds: readonly LeverKind[], charW: number): number {
  const items = kinds.map((k) => MARK.lever + MARK.labelGap + LEGEND_TEXT[k].length * charW)
  return items.reduce((a, b) => a + b, 0) + Math.max(0, items.length - 1) * LEGEND_SEP
}

/** The legend's words: the rows' own wording ("If you repay 460 USDC · …"). */
export const LEGEND_TEXT: Record<LeverKind, string> = { repay: 'if you repay', add: 'if you add' }
/** Space between two legend items. */
export const LEGEND_SEP = 8
