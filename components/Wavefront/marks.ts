/**
 * The marks. Every state is a colour AND a shape (DESIGN_RULES §2: never colour alone; red and
 * amber differ by hue only, so the shape carries the meaning):
 *
 *   sold      solid hex       danger (blood) — red means collateral sold, on BOTH sides; older
 *                             sales fade (ink density, not a new hue), but never below 3:1
 *                             against the page (`ageAlphas`)
 *   armed     ▲ triangle      warning (gold) — the 8h window is running
 *   gridEnd   ░ hatched hex   warning (gold) stripes — a window still running when the data
 *                             ends, which the census counts as sold by assumption (†)
 *   kept      ● dot           success (phosphor; the night-edition "moss")
 *   pending   hollow hex      textSecondary — walked, no Membrane decision yet (live only)
 *
 * The same geometry draws the canvas marks and the legend glyphs, so a legend glyph is the
 * mark itself.
 */

import { SEMANTIC_COLORS } from '@/config/semanticColors'

import { AGE_BUCKETS, CODE_COUNT, MARK } from './model'

export type MarkKind = 'sold' | 'armed' | 'gridEnd' | 'kept' | 'pending'

export const MARK_TOKEN: Record<MarkKind, string> = {
  sold: SEMANTIC_COLORS.danger,
  armed: SEMANTIC_COLORS.warning,
  gridEnd: SEMANTIC_COLORS.warning,
  kept: SEMANTIC_COLORS.success,
  pending: SEMANTIC_COLORS.textSecondary,
}

export const kindOf = (code: number): MarkKind =>
  code === MARK.kept
    ? 'kept'
    : code === MARK.armed
      ? 'armed'
      : code === MARK.gridEnd
        ? 'gridEnd'
        : code === MARK.pending
          ? 'pending'
          : 'sold'

// ------------------------------------------------------------------ contrast

/** WCAG 2.x non-text contrast minimum. */
export const MIN_MARK_CONTRAST = 3

type RGB = [number, number, number]

/** '#rrggbb', '#rgb' or 'rgb(a)(r, g, b…)' → 0..255 channels; null when unparseable. */
export function parseColor(c: string): RGB | null {
  const s = c.trim()
  let m = /^#([0-9a-f]{6})$/i.exec(s)
  if (m) {
    const v = parseInt(m[1], 16)
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
  }
  m = /^#([0-9a-f]{3})$/i.exec(s)
  if (m) return [...m[1]].map((h) => parseInt(h + h, 16)) as RGB
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])]
  return null
}

const lin = (v: number) => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const luminance = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)

export function contrastRatio(a: RGB, b: RGB): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** `fg` at opacity `alpha` over `bg`, composited the way canvas does (sRGB space). */
export const blend = (fg: RGB, bg: RGB, alpha: number): RGB =>
  [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha)) as RGB

/**
 * Opacity per age bucket (newest .. oldest) for sold marks: from 1 down to the lowest opacity
 * that still meets `minRatio` against `bg` (rounded up to 0.01). If the colour itself is
 * under `minRatio`, nothing fades.
 */
export function ageAlphas(fg: string, bg: string, minRatio = MIN_MARK_CONTRAST): number[] {
  const f = parseColor(fg)
  const b = parseColor(bg)
  if (!f || !b || contrastRatio(f, b) < minRatio) return new Array(AGE_BUCKETS).fill(1)
  let lo = 0
  let hi = 1
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    if (contrastRatio(blend(f, b, mid), b) >= minRatio) hi = mid
    else lo = mid
  }
  const floor = Math.min(1, Math.ceil(hi * 100) / 100)
  return Array.from({ length: AGE_BUCKETS }, (_, k) => 1 - ((1 - floor) * k) / (AGE_BUCKETS - 1))
}

// ------------------------------------------------------------------ geometry

const SIN60 = Math.sqrt(3) / 2

/**
 * Add one mark to a path. rho = the cell's hex circumradius, px.
 *
 * Filled polygons are left open: fill() closes every subpath anyway, and closePath() on
 * thousands of contours of one Path2D sends Chromium's software rasterizer down a path ~50×
 * slower (3,200 hexes: 88 ms closed vs 1.5 ms open). Stroked ones (`close`) are closed.
 */
export function addMark(
  path: CanvasPath,
  kind: MarkKind,
  cx: number,
  cy: number,
  rho: number,
  close = false,
) {
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
    if (close) path.closePath()
    return
  }
  // sold / gridEnd / pending: pointy-top hex
  path.moveTo(cx, cy - rho)
  path.lineTo(cx + rho * SIN60, cy - rho / 2)
  path.lineTo(cx + rho * SIN60, cy + rho / 2)
  path.lineTo(cx, cy + rho)
  path.lineTo(cx - rho * SIN60, cy + rho / 2)
  path.lineTo(cx - rho * SIN60, cy - rho / 2)
  if (close) path.closePath()
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

// ------------------------------------------------------------------ drawing

/** Concrete colours (canvas cannot resolve var()) and the page behind the marks. */
export interface MarkPalette extends Record<MarkKind, string> {
  bg: string
  /** Opacity per age bucket for sold marks (from `ageAlphas`). */
  ageAlpha: number[]
}

export interface DrawInput {
  ctx: CanvasRenderingContext2D
  /** Mark code per mark (MARK.*). */
  codes: Uint8Array
  /** Mark centre per mark, px. */
  xs: Float32Array
  ys: Float32Array
  /** Hex circumradius, px. */
  rho: number
  palette: MarkPalette
  /** Device pixel ratio the context is scaled by (crisp hatching). */
  dpr: number
}

/** Diagonal stripes ~3 CSS px apart, built at device resolution, as a pattern in CSS px. */
function stripes(ctx: CanvasRenderingContext2D, color: string, dpr: number): CanvasPattern | null {
  if (typeof document === 'undefined') return null
  const period = Math.max(3, Math.round(3 * dpr))
  const width = Math.max(1, Math.round(1.1 * dpr))
  const c = document.createElement('canvas')
  c.width = period
  c.height = period
  const g = c.getContext('2d')
  if (!g) return null
  g.fillStyle = color
  for (let x = 0; x < period; x++)
    for (let y = 0; y < period; y++) if ((x + y) % period < width) g.fillRect(x, y, 1, 1)
  const p = ctx.createPattern(c, 'repeat')
  if (p && typeof DOMMatrix !== 'undefined') {
    p.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, 0, 0]))
  }
  return p
}

/**
 * Draw one panel's marks: one Path2D per (state, age), so ~3,200 marks cost a handful of
 * fills, not 3,200.
 */
export function drawMarks({ ctx, codes, xs, ys, rho, palette, dpr }: DrawInput): void {
  const groups: (Path2D | null)[] = new Array(CODE_COUNT).fill(null)
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]
    let p = groups[code]
    if (!p) p = groups[code] = new Path2D()
    const kind = kindOf(code)
    if (kind === 'pending') addMark(p, kind, xs[i], ys[i], rho * 0.84, true)
    else addMark(p, kind, xs[i], ys[i], rho)
  }
  ctx.save()
  groups.forEach((p, code) => {
    if (!p) return
    const kind = kindOf(code)
    ctx.globalAlpha = kind === 'sold' ? (palette.ageAlpha[code - MARK.sold] ?? 1) : 1
    if (kind === 'pending') {
      ctx.strokeStyle = palette.pending
      ctx.lineWidth = Math.max(1, rho * 0.22)
      ctx.stroke(p)
      return
    }
    if (kind === 'gridEnd') {
      ctx.fillStyle = stripes(ctx, palette.gridEnd, dpr) ?? palette.gridEnd
      ctx.fill(p)
      return
    }
    ctx.fillStyle = palette[kind]
    ctx.fill(p)
  })
  ctx.restore()
}
