/**
 * The marks. Every state is a colour AND a shape (DESIGN_RULES §2: never colour alone; red and
 * amber differ by hue only, so the shape carries the meaning):
 *
 *   sold    solid hex     danger (blood) — red means collateral sold, on BOTH sides; faded by
 *                         age like the canvas `redAge` (ink density, not a new hue)
 *   armed   ▲ triangle    warning (gold) — the 8h window is running
 *   kept    ● dot         success (phosphor; the night-edition "moss")
 *
 * Only walked positions are drawn, so there is no "not compared" mark: those positions are
 * counted in the coverage line instead.
 *
 * The same geometry draws the canvas marks and the legend glyphs, so a legend glyph is the
 * mark itself.
 */

import { SEMANTIC_COLORS } from '@/config/semanticColors'

import { AGE_BUCKETS, MARK } from './model'

export type MarkKind = 'sold' | 'armed' | 'kept'

export const MARK_TOKEN: Record<MarkKind, string> = {
  sold: SEMANTIC_COLORS.danger,
  armed: SEMANTIC_COLORS.warning,
  kept: SEMANTIC_COLORS.success,
}

/** Opacity per age bucket for sold marks (newest .. oldest). */
export const AGE_ALPHA: readonly number[] = [1, 0.8, 0.6, 0.44, 0.32]

export const kindOf = (code: number): MarkKind =>
  code === MARK.kept ? 'kept' : code === MARK.armed ? 'armed' : 'sold'

const SIN60 = Math.sqrt(3) / 2

/**
 * Add one mark to a path. rho = the cell's hex circumradius, px.
 *
 * Polygons are left open: fill() closes every subpath anyway, and closePath() on thousands
 * of contours of one Path2D sends Chromium's software rasterizer down a path ~50× slower
 * (3,200 hexes: 88 ms closed vs 1.5 ms open).
 */
export function addMark(path: CanvasPath, kind: MarkKind, cx: number, cy: number, rho: number) {
  if (kind === 'kept') {
    const r = rho * 0.68
    path.moveTo(cx + r, cy)
    path.arc(cx, cy, r, 0, Math.PI * 2)
    return
  }
  if (kind === 'armed') {
    // Inscribed in the hex: vertices at the hex's top, lower-right and lower-left corners.
    path.moveTo(cx, cy - rho)
    path.lineTo(cx + rho * SIN60, cy + rho / 2)
    path.lineTo(cx - rho * SIN60, cy + rho / 2)
    return
  }
  // sold: pointy-top hex
  path.moveTo(cx, cy - rho)
  path.lineTo(cx + rho * SIN60, cy - rho / 2)
  path.lineTo(cx + rho * SIN60, cy + rho / 2)
  path.lineTo(cx, cy + rho)
  path.lineTo(cx - rho * SIN60, cy + rho / 2)
  path.lineTo(cx - rho * SIN60, cy - rho / 2)
}

/** SVG path data for a legend glyph centred in a size×size box. */
export function markPathD(kind: MarkKind, size: number): string {
  const c = size / 2
  const rho = size / 2
  if (kind === 'kept') {
    const r = rho * 0.68
    return `M ${c - r} ${c} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`
  }
  const pts: [number, number][] =
    kind === 'armed'
      ? [
          [c, c - rho],
          [c + rho * SIN60, c + rho / 2],
          [c - rho * SIN60, c + rho / 2],
        ]
      : [
          [c, c - rho],
          [c + rho * SIN60, c - rho / 2],
          [c + rho * SIN60, c + rho / 2],
          [c, c + rho],
          [c - rho * SIN60, c + rho / 2],
          [c - rho * SIN60, c - rho / 2],
        ]
  return `M ${pts.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(' L ')} Z`
}

/** Concrete colours (canvas cannot resolve var()). */
export type MarkPalette = Record<MarkKind, string>

export interface DrawInput {
  ctx: CanvasRenderingContext2D
  /** Mark code per position (MARK.*). */
  codes: Uint8Array
  /** Hex centre per position, px. */
  xs: Float32Array
  ys: Float32Array
  /** Hex circumradius, px. */
  rho: number
  palette: MarkPalette
}

/**
 * Draw one panel's marks: one Path2D per (state, age), so ~3,200 marks cost a handful of
 * fills, not 3,200.
 */
export function drawMarks({ ctx, codes, xs, ys, rho, palette }: DrawInput): void {
  const groups: (Path2D | null)[] = new Array(MARK.sold + AGE_BUCKETS).fill(null)
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]
    let p = groups[code]
    if (!p) p = groups[code] = new Path2D()
    addMark(p, kindOf(code), xs[i], ys[i], rho)
  }
  ctx.save()
  groups.forEach((p, code) => {
    if (!p) return
    const kind = kindOf(code)
    ctx.globalAlpha = kind === 'sold' ? AGE_ALPHA[code - MARK.sold] : 1
    ctx.fillStyle = palette[kind]
    ctx.fill(p)
  })
  ctx.restore()
}
