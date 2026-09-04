// Pure ports of the proto's inline JS: decision-surface math, the duel
// simulator, and the three canvas painters. Formulas are kept byte-for-byte
// with public/proto/defend.html so the numbers match exactly.

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { resolveColor } from '@/helpers/resolveToken'

import {
  BASE,
  DEPTH,
  JUNIOR,
  REGIMES,
  VAULT_LIVE,
  VOL8H,
  VOLSTRESS,
} from './fixtures'
import {
  DecisionParams,
  DecisionReadout,
  DuelResult,
  InstantResult,
  MembraneResult,
  RegimeKey,
  SimStep,
} from './types'

// Canvas palette — semantic tokens only (proto raw hex mapped 1:1).
const C = {
  ink: SEMANTIC_COLORS.textPrimary, // #ece6d8 bone
  dim: SEMANTIC_COLORS.textSecondary, // #8d877b
  faint: SEMANTIC_COLORS.textTertiary, // #56524a
  phos: SEMANTIC_COLORS.success, // #9bdc4f
  teal: SEMANTIC_COLORS.info, // #46d39a
  gold: SEMANTIC_COLORS.warning, // #d8b24a
  blood: SEMANTIC_COLORS.danger, // #cf4034
  hairS: SEMANTIC_COLORS.borderStrong, // rgba(236,230,216,0.22)
} as const

const MONO = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"

/** Proto `fmtPct` — percent with adaptive precision. */
export function fmtPct(x: number): string {
  const digits = x < 0.9995 && (x * 100) % 1 !== 0 ? 2 : 0
  return (x * 100).toFixed(digits).replace(/\.00$/, '') + '%'
}

// -------------------- decision surface --------------------

/** Derive the whole display-ready readout from the lever params. */
export function computeDecision(P: DecisionParams): DecisionReadout {
  const M = P.M
  const g = P.g
  const B = Math.max(0.4, M - g)
  const wipe = Math.sqrt(M)
  const trig = M * 1.04

  const head = wipe - trig
  const headClass = head < 0.03 ? 'bad' : head < 0.05 ? 'warn' : 'ok'

  // COUPLING 1 — delay safety.
  const budget = 1 - M
  const dSafe = 8 * Math.pow(budget / (VOL8H / 100), 2)
  const dYourClass = P.delay > dSafe ? 'bad' : P.delay > dSafe * 0.6 ? 'warn' : 'ok'
  const dYourVal =
    P.delay === 0
      ? 'none — instant execution, no cure'
      : P.delay +
        'h' +
        (P.delay > dSafe
          ? ' — positions can go UNDERWATER inside your own window'
          : ' — inside the safe bound')

  // COUPLING 2 — cap vs the house formula.
  const houseCap = DEPTH * (1 + JUNIOR - VOLSTRESS)
  const maxScale = 100
  const over = P.cap > houseCap
  const capBar = {
    greenPct: (Math.min(P.cap, houseCap) / maxScale) * 100,
    over,
    redLeftPct: (houseCap / maxScale) * 100,
    redWidthPct: over ? ((P.cap - houseCap) / maxScale) * 100 : 0,
    tickPct: (houseCap / maxScale) * 100,
  }
  const capFlag = over
    ? '$' + (P.cap - houseCap).toFixed(0) + 'M cannot be cleared in a cascade'
    : '$' + (houseCap - P.cap).toFixed(0) + 'M of headroom unused'

  // COUPLING 3 — oracle staleness.
  const err = VOL8H * Math.sqrt(P.stale / 480)
  const frz: number = { 1: 14, 15: 2, 60: 0 }[P.stale] ?? 0
  const oraFrz =
    frz +
    ' min — ' +
    (frz > 10 ? 'un-liquidatable windows add up' : frz > 0 ? 'tolerable' : 'never freezes, every error prices in')

  return {
    M,
    g,
    B,
    wipe,
    trig,
    mVal: fmtPct(M),
    gVal: fmtPct(g),
    capVal: '$' + P.cap + 'M',
    bVal: fmtPct(B),
    wipeVal: fmtPct(wipe),
    headVal: (head * 100).toFixed(1) + ' pts',
    headClass,
    effVal: '+' + ((B / 0.75 - 1) * 100).toFixed(0) + '% borrowable per $',
    dSafeVal: dSafe > 48 ? '>48h' : dSafe.toFixed(1) + 'h',
    dYourVal,
    dYourClass,
    capHouse: '$' + houseCap.toFixed(0) + 'M',
    capBar,
    capFlag,
    capFlagClass: over ? 'bad' : 'ok',
    oraErr: '±' + err.toFixed(2) + '%',
    oraFrz,
    oraFrzClass: frz > 10 ? 'warn' : 'ok',
  }
}

// -------------------- duel simulator --------------------

/**
 * Run the same randomized price path through both venues.
 * Uses Math.random exactly like the proto, so each call is a fresh path.
 */
export function runDuel(M: number, g: number, regimeKey: RegimeKey): DuelResult {
  const B = M - g
  const trig = M * 1.04
  const rg = REGIMES[regimeKey]

  // one shared path: 90 steps of 8h
  const px: number[] = [1]
  for (let i = 1; i < 90; i++) {
    let r = (Math.random() * 2 - 1) * rg.vol
    if (rg.jump && i === 40) r -= rg.jump
    px.push(px[i - 1] * (1 + r))
  }

  // Membrane: breach starts a 1-step (8h) timer; cure if back under M;
  // band trig = instant partial to B.
  function simMembrane(): MembraneResult {
    let debt = B
    let timer = 0
    let liqs = 0
    let equity = 1
    const out: SimStep[] = []
    for (let i = 0; i < px.length; i++) {
      const ltv = debt / px[i]
      let ev: SimStep['ev'] = ''
      if (ltv >= trig || (ltv > M && timer >= 1)) {
        const need = Math.max(0, debt - B * px[i])
        const seize = ltv >= Math.sqrt(M) ? 1 : (need / px[i]) * 1.02
        equity = Math.max(0, equity - seize * 0.02 - Math.max(0, need * 0.01))
        debt = B * px[i]
        liqs++
        timer = 0
        ev = 'liq'
      } else if (ltv > M) {
        timer++
        ev = 'timer'
      } else {
        timer = 0
      }
      out.push({ p: px[i], ev })
    }
    return { out, liqs, equity, end: px[px.length - 1] - debt }
  }

  // Instant venue: liquidate at first touch of M (full close, 5% penalty).
  function simInstant(): InstantResult {
    let debt = B
    let liqs = 0
    let equity = 1
    const out: SimStep[] = []
    for (let i = 0; i < px.length; i++) {
      const ltv = debt / px[i]
      let ev: SimStep['ev'] = ''
      if (ltv > M) {
        equity = Math.max(0, equity - 0.05)
        debt = B * px[i]
        liqs++
        ev = 'liq'
      }
      out.push({ p: px[i], ev })
    }
    return { out, liqs, equity }
  }

  return { B, membrane: simMembrane(), instant: simInstant() }
}

// -------------------- canvas painters --------------------
// Each painter assumes the caller already applied the DPR transform and
// passes logical (CSS-pixel) width/height.

/** Paint the decision-surface band chart. */
export function drawDecisionSurface(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  P: DecisionParams,
): void {
  ctx.clearRect(0, 0, W, H)
  const M = P.M
  const PAD = 30
  const X = (v: number) => PAD + ((W - 2 * PAD) * (v - 0.7)) / 0.3

  // axis: LTV from 70% to 100%
  ctx.strokeStyle = resolveColor(C.hairS)
  ctx.beginPath()
  ctx.moveTo(PAD, H - 26)
  ctx.lineTo(W - PAD, H - 26)
  ctx.stroke()
  ctx.fillStyle = resolveColor(C.faint)
  ctx.font = '9px ' + MONO
  ctx.textAlign = 'center'
  ;[0.7, 0.8, 0.9, 1.0].forEach((v) => ctx.fillText(fmtPct(v), X(v), H - 12))

  const g = P.g
  const B = Math.max(0.4, M - g)
  const wipe = Math.sqrt(M)
  const trig = M * 1.04

  const band = (a: number, b: number, color: string, alpha: number) => {
    ctx.fillStyle = resolveColor(color)
    ctx.globalAlpha = alpha
    ctx.fillRect(X(a), 44, X(Math.min(b, 1)) - X(a), H - 70)
    ctx.globalAlpha = 1
  }
  band(B, M, C.phos, 0.16)
  band(M, trig, C.gold, 0.18)
  band(trig, wipe, C.dim, 0.12)
  band(wipe, 1.0, C.blood, 0.22)

  const mark = (v: number, label: string, color: string) => {
    const c = resolveColor(color)
    ctx.strokeStyle = c
    ctx.beginPath()
    ctx.moveTo(X(v), 40)
    ctx.lineTo(X(v), H - 26)
    ctx.stroke()
    ctx.fillStyle = c
    ctx.textAlign = 'center'
    ctx.fillText(label, Math.min(W - 30, Math.max(30, X(v))), 34)
  }
  mark(B, 'B ' + fmtPct(B), C.phos)
  mark(M, 'M ' + fmtPct(M), C.ink)
  mark(trig, 'trigger', C.gold)
  mark(wipe, '√M wipeout ' + fmtPct(wipe), C.blood)

  // baselines as small ticks under the axis
  BASE.forEach((b) => {
    ctx.strokeStyle = resolveColor(C.teal)
    ctx.globalAlpha = 0.8
    ctx.beginPath()
    ctx.moveTo(X(b.m), H - 26)
    ctx.lineTo(X(b.m), H - 32)
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.fillStyle = resolveColor(C.teal)
    ctx.font = '8px ' + MONO
    ctx.fillText(b.nm, X(b.m), H - 2)
  })
}

/** Paint one duel price path with liq/timer markers. */
export function drawDuelPath(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  out: SimStep[],
  showTimerLegend: boolean,
): void {
  ctx.clearRect(0, 0, W, H)
  const ps = out.map((o) => o.p)
  const lo = Math.min(...ps) * 0.98
  const hi = Math.max(...ps) * 1.02
  const X = (i: number) => 8 + ((W - 16) * i) / (out.length - 1)
  const Y = (p: number) => 30 + (H - 44) * (1 - (p - lo) / (hi - lo))

  ctx.strokeStyle = resolveColor(C.ink)
  ctx.lineWidth = 1.5
  ctx.beginPath()
  out.forEach((o, i) => (i ? ctx.lineTo(X(i), Y(o.p)) : ctx.moveTo(X(i), Y(o.p))))
  ctx.stroke()

  out.forEach((o, i) => {
    if (o.ev === 'liq') {
      ctx.fillStyle = resolveColor(C.blood)
      ctx.fillRect(X(i) - 2, Y(o.p) - 2, 5, 5)
    } else if (o.ev === 'timer') {
      ctx.fillStyle = resolveColor(C.gold)
      ctx.fillRect(X(i) - 1.5, Y(o.p) - 1.5, 3.5, 3.5)
    }
  })

  ctx.font = '8.5px ' + MONO
  ctx.textAlign = 'left'
  if (showTimerLegend) {
    ctx.fillStyle = resolveColor(C.gold)
    ctx.fillText('gold = timer ticking', 10, H - 8)
  }
  ctx.fillStyle = resolveColor(C.blood)
  ctx.fillText('red = liquidation', showTimerLegend ? 130 : 10, H - 8)
}

/** Paint the vault sim-expectation band vs the live line. */
export function drawVault(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  ctx.clearRect(0, 0, W, H)
  const N = 26
  const P = 14
  const X = (i: number) => P + ((W - 2 * P) * i) / (N - 1)
  const Y = (v: number) => H - P - ((H - 2 * P) * (v + 1)) / 6

  // sim expectation band (middle 80% of scored sims)
  ctx.beginPath()
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1)
    const hi = 3.86 + 0.9 - t * 0.25
    i ? ctx.lineTo(X(i), Y(hi)) : ctx.moveTo(X(i), Y(hi))
  }
  for (let i = N - 1; i >= 0; i--) {
    const t = i / (N - 1)
    const lo = 3.86 - 1.1 - t * 0.35
    ctx.lineTo(X(i), Y(lo))
  }
  ctx.closePath()
  ctx.globalAlpha = 0.15
  ctx.fillStyle = resolveColor(C.teal)
  ctx.fill()
  ctx.globalAlpha = 1

  // live line, drifting to the band's lower half
  ctx.strokeStyle = resolveColor(C.ink)
  ctx.lineWidth = 1.5
  ctx.beginPath()
  VAULT_LIVE.forEach((v, i) => {
    const x = X(((i * (N - 1)) / (VAULT_LIVE.length - 1)) * 0.46)
    i ? ctx.lineTo(x, Y(v)) : ctx.moveTo(x, Y(v))
  })
  ctx.stroke()

  ctx.font = '8.5px ' + MONO
  ctx.fillStyle = resolveColor(C.teal)
  ctx.fillText('sim expectation band', W - 150, 18)
  ctx.fillStyle = resolveColor(C.ink)
  ctx.fillText('live, 12 weeks', 16, 18)
  ctx.fillStyle = resolveColor(C.gold)
  ctx.fillText('drift: −0.9 vs sim median — shown, not hidden', 16, H - 6)
}
