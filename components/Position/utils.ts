// Pure functions ported from public/proto/dash.html's inline JS: formatters,
// the belt + chart canvas painters, the spread dial math, and the lifestyle
// equivalence calc. All colours come from SEMANTIC_COLORS so the canvas stays in
// the design system.

import React from 'react'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { resolveColor } from '@/helpers/resolveToken'
import { LifeItem, VenueClass } from './types'

// ---------- colour helpers ----------
// The proto used a --sunk (#070708) surface slightly below bgPrimary; the nearest
// token is bgPrimary, which we use for every sunk track/canvas background.
export const SUNK = SEMANTIC_COLORS.bgPrimary

/** Venue class → swatch colour, sourced from tokens (gold / bone / teal). */
export const CLASS_COLOR: Record<VenueClass, string> = {
  synth: SEMANTIC_COLORS.warning,
  stable: SEMANTIC_COLORS.textPrimary,
  lst: SEMANTIC_COLORS.info,
}

/** rgba() from a token + alpha — resolves the token first, then keeps decorative fills sourced from tokens. */
export const withAlpha = (hex: string, a: number): string => {
  const resolved = resolveColor(hex)
  // Border tokens resolve to rgb()/rgba(); recompose with the requested alpha.
  if (resolved.startsWith('rgb')) {
    const [r, g, b] = resolved.match(/[\d.]+/g) || []
    return `rgba(${r},${g},${b},${a})`
  }
  const h = resolved.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${a})`
}

// ---------- formatters ----------
export const usdc = (n: number): string => '$' + Math.round(n).toLocaleString('en-US')
export const money = (n: number): string => '$' + n.toFixed(2)

// ---------- spread dial ----------
export interface SpreadState {
  sp: number
  inv: boolean
  zeroLeft: number
  barLeft: number
  barWidth: number
  valText: string
  note: string
  nudgeBody: string
}

export const computeSpread = (
  apr: number,
  borrow: number,
  axis: { LO: number; HI: number }
): SpreadState => {
  const pos = (v: number) => ((v - axis.LO) / (axis.HI - axis.LO)) * 100
  const sp = apr - borrow
  const inv = sp < 0
  const zeroLeft = pos(0)
  const barLeft = pos(Math.min(0, sp))
  const barWidth = Math.abs(pos(sp) - pos(0))
  const valText = (sp >= 0 ? '+' : '−') + Math.abs(sp).toFixed(1) + '%'
  const note = inv
    ? `Venues pay ${apr.toFixed(1)}%, the loan now costs ${borrow.toFixed(1)}%. While the spread is ` +
      'negative, compounding adds debt faster than it earns, so Repay strictly dominates — it is the ' +
      'only leg that cannot lose here. Nothing has been switched for you.'
    : `Venues pay ${apr.toFixed(1)}%, the loan costs ${borrow.toFixed(1)}%. While that spread is positive, ` +
      'compounding out-earns repaying — but repaying is the leg that cannot lose, and it cuts LTV ' +
      'strictly faster. That is the trade, and it is yours to make. Nothing here picks for you.'
  const nudgeBody =
    `Venue rates fell to ${apr.toFixed(1)}% while the variable borrow rate spiked to ${borrow.toFixed(1)}%. ` +
    `Every harvest you compound from here costs you ${Math.abs(sp).toFixed(1)}% a year against itself. ` +
    'Repay does not have that problem, and it pulls your LTV down at the same time. Your call — I will not move it.'
  return { sp, inv, zeroLeft, barLeft, barWidth, valText, note, nudgeBody }
}

// ---------- lifestyle equivalence ----------
export interface LifeBlocks {
  full: number
  frac: number
  overflow: number
}

export const lifeBlocks = (cover: number): LifeBlocks => {
  const capped = Math.min(cover, 12)
  const full = Math.floor(capped)
  const frac = capped - full
  const overflow = cover > 12 ? Math.round(cover - 12) : 0
  return { full, frac: frac > 0.03 && full < 12 ? frac : 0, overflow }
}

/** Default lifestyle item: tightest full cover (smallest multiple ≥ 1). */
export const lifeStartIndex = (rateMo: number, items: LifeItem[]): number => {
  let start = 0
  let best = Infinity
  items.forEach((x, i) => {
    const c = rateMo / x.mo
    if (c >= 1 && c < best) {
      best = c
      start = i
    }
  })
  return start
}

// ---------- emphasis renderer ----------
// Encounter bodies carry **bold** (→ phosphor) and {neg}…{/neg} (→ blood) markers.
// Returns React nodes without JSX so this stays a .ts module.
export const renderEmphasis = (text: string): React.ReactNode[] => {
  const nodes: React.ReactNode[] = []
  // Bold wrapped AROUND a neg span (**{neg}…{/neg}**) collapses to the neg span —
  // otherwise the orphaned ** chunks render literally.
  const normalized = text.replace(/\*\*(\{neg\}.*?\{\/neg\})\*\*/g, '$1')
  // Split on {neg}…{/neg} first, then on ** … ** inside each chunk.
  const negParts = normalized.split(/(\{neg\}.*?\{\/neg\})/g)
  let key = 0
  negParts.forEach((part) => {
    const negMatch = part.match(/^\{neg\}(.*)\{\/neg\}$/)
    if (negMatch) {
      // The neg span itself may contain ** ** which we strip to plain bold-blood.
      const inner = negMatch[1].replace(/\*\*/g, '')
      nodes.push(
        React.createElement(
          'b',
          { key: key++, style: { fontWeight: 400, color: SEMANTIC_COLORS.danger } },
          inner
        )
      )
      return
    }
    const boldParts = part.split(/(\*\*.*?\*\*)/g)
    boldParts.forEach((bp) => {
      const boldMatch = bp.match(/^\*\*(.*)\*\*$/)
      if (boldMatch) {
        nodes.push(
          React.createElement(
            'b',
            { key: key++, style: { fontWeight: 400, color: SEMANTIC_COLORS.success } },
            boldMatch[1]
          )
        )
      } else if (bp) {
        nodes.push(React.createElement(React.Fragment, { key: key++ }, bp))
      }
    })
  })
  return nodes
}

// ---------- belt animation ----------
// Venues on the left drip packets rightward; at the debt bar each packet loses its
// interest share (outline vs core = gross vs net) and the bar flashes. Packet AREA
// encodes the venue's measured $/day. Self-contained (no querySelector).
const NET = 0.82
const LANE_TONE: VenueClass[] = ['synth', 'stable', 'stable']

interface Packet {
  lane: number
  x: number
  dead?: boolean
}

export interface BeltAnimation {
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number, dt: number) => void
}

export const createBeltAnimation = (laneRate: number[]): BeltAnimation => {
  const rmax = Math.max.apply(null, laneRate)
  const laneR = laneRate.map((r) => 6.5 * Math.sqrt(r / rmax))
  const laneTimers = laneRate.map((_, i) => 0.7 + i * 0.7)
  let packets: Packet[] = []
  let debtFlash = 0

  const draw = (ctx: CanvasRenderingContext2D, w: number, h: number, dt: number) => {
    ctx.clearRect(0, 0, w, h)
    debtFlash = Math.max(0, debtFlash - dt * 2)

    const n = laneRate.length
    // Lanes evenly distributed down the canvas height.
    const lanes = laneRate.map((_, i) => ((i + 0.5) / n) * h)
    const debtX = w - 26

    // The debt bar spans every lane: one loan, three feeders.
    ctx.fillStyle = debtFlash > 0 ? resolveColor(SEMANTIC_COLORS.danger) : withAlpha(SEMANTIC_COLORS.danger, 0.5)
    ctx.fillRect(debtX, 6, 14, h - 12)
    ctx.save()
    ctx.translate(debtX + 11, h / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.fillStyle = resolveColor(SEMANTIC_COLORS.bgPrimary)
    ctx.font = '8px ui-monospace,monospace'
    ctx.textAlign = 'center'
    ctx.fillText('DEBT', 0, 0)
    ctx.restore()

    // Uniform cadence; the yield lives in the packet size.
    lanes.forEach((_, i) => {
      laneTimers[i] -= dt
      if (laneTimers[i] <= 0) {
        packets.push({ lane: i, x: 8 })
        laneTimers[i] = 2.0 + Math.random() * 0.5
      }
    })

    packets.forEach((pk) => {
      const y = lanes[pk.lane]
      if (y === undefined) {
        pk.dead = true
        return
      }
      pk.x += (w / 7) * dt
      if (pk.x >= debtX - 4) {
        pk.dead = true
        debtFlash = 1
        return
      }
      const r = laneR[pk.lane]
      const core = r * Math.sqrt(NET)
      ctx.strokeStyle = withAlpha(SEMANTIC_COLORS.textPrimary, 0.25)
      ctx.strokeRect(pk.x - r, y - r, r * 2, r * 2)
      ctx.fillStyle = resolveColor(CLASS_COLOR[LANE_TONE[pk.lane]])
      ctx.fillRect(pk.x - core, y - core, core * 2, core * 2)
    })
    packets = packets.filter((pk) => !pk.dead)
  }

  return { draw }
}

// ---------- delivered-cumulative chart ----------
export const drawChart = (
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  d: number[],
  benchMode: 'hold' | 'sold' | null,
  benchSoldEnd: number
) => {
  ctx.clearRect(0, 0, w, h)
  const max = d[d.length - 1] * 1.08
  const P = 14
  const X = (i: number) => P + ((w - 2 * P) * i) / (d.length - 1)
  const Y = (v: number) => h - P - ((h - 2 * P) * v) / max

  // Gradient area under the line.
  const g = ctx.createLinearGradient(0, P, 0, h - P)
  g.addColorStop(0, withAlpha(SEMANTIC_COLORS.success, 0.22))
  g.addColorStop(1, withAlpha(SEMANTIC_COLORS.success, 0.02))
  ctx.beginPath()
  ctx.moveTo(X(0), Y(d[0]))
  d.forEach((v, i) => ctx.lineTo(X(i), Y(v)))
  ctx.lineTo(X(d.length - 1), h - P)
  ctx.lineTo(X(0), h - P)
  ctx.closePath()
  ctx.fillStyle = g
  ctx.fill()

  ctx.beginPath()
  ctx.moveTo(X(0), Y(d[0]))
  d.forEach((v, i) => ctx.lineTo(X(i), Y(v)))
  ctx.strokeStyle = resolveColor(SEMANTIC_COLORS.success)
  ctx.lineWidth = 2
  ctx.stroke()

  // Plateau annotation: longest flat run.
  let s0 = 0
  let len = 0
  let bs = 0
  let bl = 0
  for (let i = 1; i < d.length; i++) {
    if (d[i] === d[i - 1]) {
      if (len === 0) s0 = i - 1
      len++
      if (len > bl) {
        bl = len
        bs = s0
      }
    } else {
      len = 0
    }
  }
  if (bl >= 2) {
    ctx.strokeStyle = withAlpha(SEMANTIC_COLORS.warning, 0.7)
    ctx.setLineDash([2, 3])
    ctx.beginPath()
    ctx.moveTo(X(bs), Y(d[bs]) - 8)
    ctx.lineTo(X(bs + bl), Y(d[bs]) - 8)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = resolveColor(SEMANTIC_COLORS.warning)
    ctx.font = '8.5px ui-monospace,monospace'
    ctx.textAlign = 'center'
    ctx.fillText('cooldown — nothing arrived', X(bs + bl / 2), Y(d[bs]) - 14)
  }

  // Endpoint value, mono.
  ctx.fillStyle = resolveColor(SEMANTIC_COLORS.textPrimary)
  ctx.font = '11px ui-monospace,monospace'
  ctx.textAlign = 'right'
  ctx.fillText('$' + d[d.length - 1].toLocaleString('en-US'), w - P - 2, Y(d[d.length - 1]) - 6)

  // Benchmark ghost.
  if (benchMode) {
    const bEnd = benchMode === 'hold' ? 0 : benchSoldEnd
    ctx.strokeStyle = withAlpha(SEMANTIC_COLORS.textPrimary, 0.55)
    ctx.setLineDash([4, 4])
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let bi = 0; bi < d.length; bi++) {
      const bv = (bEnd * bi) / (d.length - 1)
      if (bi === 0) ctx.moveTo(X(bi), Y(bv))
      else ctx.lineTo(X(bi), Y(bv))
    }
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = resolveColor(SEMANTIC_COLORS.textSecondary)
    ctx.font = '8.5px ui-monospace,monospace'
    ctx.textAlign = 'left'
    ctx.fillText(
      benchMode === 'hold'
        ? 'just holding: $0 delivered'
        : 'sold in Jan: $' + bEnd + ' cash interest, net of exit cost + tax',
      P + 2,
      Y(bEnd) - 6
    )
  }
}
