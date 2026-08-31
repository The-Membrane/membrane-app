/**
 * Shareability: URL state and the share-card PNG.
 *
 * A result must reproduce from its link alone, so the address and every input that
 * changes the outcome lives in the query string. The card is drawn on a canvas in the
 * Living Typeface palette, the same approach as the Builder's share card
 * (components/Builder/hooks/useBuilderEngine.ts drawResultCard).
 */

import type { Comparison } from './types'

// ------------------------------------------------------------------ url state

export interface SimUrlState {
  address?: string
  /** Protocol + market of the position being shown, so a shared link opens on it. */
  position?: string
  membraneMaxLtv?: number
  liqFee?: number
  recallRate?: number
  fastRate?: number
  deployedUsd?: number
}

const numParam = (v: string | string[] | undefined): number | undefined => {
  const s = Array.isArray(v) ? v[0] : v
  if (s === undefined || s === '') return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}
const strParam = (v: string | string[] | undefined): string | undefined => {
  const s = Array.isArray(v) ? v[0] : v
  return s && s.length ? s : undefined
}

export function readUrlState(query: Record<string, string | string[] | undefined>): SimUrlState {
  return {
    address: strParam(query.a),
    position: strParam(query.p),
    membraneMaxLtv: numParam(query.ltv),
    liqFee: numParam(query.fee),
    recallRate: numParam(query.recall),
    fastRate: numParam(query.fast),
    deployedUsd: numParam(query.dep),
  }
}

export function writeUrlState(s: SimUrlState): string {
  const q = new URLSearchParams()
  if (s.address) q.set('a', s.address)
  if (s.position) q.set('p', s.position)
  if (s.membraneMaxLtv !== undefined) q.set('ltv', s.membraneMaxLtv.toFixed(4))
  if (s.liqFee !== undefined) q.set('fee', s.liqFee.toFixed(4))
  if (s.recallRate !== undefined) q.set('recall', s.recallRate.toFixed(4))
  if (s.fastRate !== undefined) q.set('fast', s.fastRate.toFixed(4))
  if (s.deployedUsd !== undefined) q.set('dep', String(Math.round(s.deployedUsd)))
  const str = q.toString()
  return str ? `?${str}` : ''
}

export function shareUrl(state: SimUrlState): string {
  if (typeof window === 'undefined') return ''
  return window.location.origin + window.location.pathname + writeUrlState(state)
}

// ----------------------------------------------------------------- share card

const BONE = '#ece6d8'
const DIM = '#8d877b'
const FAINT = '#56524a'
const PHOS = '#9bdc4f'
const BLOOD = '#cf4034'
const PAGE = '#09090a'
const HAIRLINE = 'rgba(236,230,216,0.10)'
const MONO = "'JetBrains Mono',Menlo,Consolas,monospace"
const SERIF = "'Redaction',Georgia,serif"

const usd = (n: number) => (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US')

/** Renders the comparison to a 1080x1350 PNG data URL, or null outside the browser. */
export function drawShareCard(cmp: Comparison, isDemo: boolean): string | null {
  if (typeof document === 'undefined') return null
  const W = 1080
  const H = 1350
  const M = 96
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const g = cv.getContext('2d')
  if (!g) return null

  g.fillStyle = PAGE
  g.fillRect(0, 0, W, H)
  g.strokeStyle = HAIRLINE
  g.lineWidth = 2
  g.strokeRect(48, 48, W - 96, H - 96)

  // Eyebrow
  try {
    g.letterSpacing = '6px'
  } catch {
    /* older browsers */
  }
  g.font = `24px ${MONO}`
  g.fillStyle = DIM
  g.fillText('MEMBRANE · POSITION SIMULATOR', M, 168)
  g.fillStyle = isDemo ? '#d8b24a' : BONE
  g.fillText(isDemo ? 'WORKED EXAMPLE · NOT A REAL WALLET' : cmp.position.label.toUpperCase(), M, 212)
  try {
    g.letterSpacing = '0px'
  } catch {
    /* ignore */
  }

  // Headline
  const delta = cmp.equityDeltaUsd
  g.font = `56px ${SERIF}`
  g.fillStyle = BONE
  const head =
    delta > 0 ? 'Membrane kept more of it.' : delta < 0 ? 'Membrane kept less of it.' : 'Both engines landed level.'
  g.fillText(head, M, 320)

  g.font = `20px ${MONO}`
  g.fillStyle = DIM
  g.fillText(cmp.scenarioLabel, M, 362)

  // The number
  try {
    g.letterSpacing = '4px'
  } catch {
    /* ignore */
  }
  g.font = `20px ${MONO}`
  g.fillStyle = DIM
  g.fillText('DIFFERENCE IN ENDING EQUITY', M, 452)
  try {
    g.letterSpacing = '0px'
  } catch {
    /* ignore */
  }
  g.font = `104px ${MONO}`
  g.fillStyle = delta >= 0 ? PHOS : BLOOD
  g.fillText((delta >= 0 ? '+' : '') + usd(delta), M, 560)

  // Two columns
  const col = (x: number, title: string, run: { endEquityUsd: number; penaltyPaidUsd: number; events: unknown[] }, accent: string) => {
    try {
      g.letterSpacing = '3px'
    } catch {
      /* ignore */
    }
    g.font = `18px ${MONO}`
    g.fillStyle = DIM
    g.fillText(title.toUpperCase(), x, 660)
    try {
      g.letterSpacing = '0px'
    } catch {
      /* ignore */
    }
    g.font = `44px ${MONO}`
    g.fillStyle = accent
    g.fillText(usd(run.endEquityUsd), x, 716)
    g.font = `20px ${MONO}`
    g.fillStyle = DIM
    g.fillText(`${run.events.length} liquidation${run.events.length === 1 ? '' : 's'}`, x, 756)
    g.fillText(`${usd(run.penaltyPaidUsd)} lost to penalties`, x, 788)
  }
  col(M, cmp.position.label, cmp.source, BONE)
  col(W / 2 + 20, 'Membrane', cmp.membrane, PHOS)

  g.strokeStyle = HAIRLINE
  g.lineWidth = 2
  g.beginPath()
  g.moveTo(M, 826)
  g.lineTo(W - M, 826)
  g.stroke()

  // Why
  g.font = `28px ${SERIF}`
  g.fillStyle = BONE
  const why = [
    'Same prices, same position, two engines.',
    'Membrane repays only enough to restore the',
    'borrow cap, recalls from venues before it sells,',
    'and allows an 8-hour window to cure a breach.',
  ]
  why.forEach((line, i) => g.fillText(line, M, 890 + i * 42))

  // Footer — provenance, always present
  g.font = `18px ${MONO}`
  g.fillStyle = FAINT
  const foot = [
    'Price path: measured 1-minute Chainlink oracle rounds, 10-11 Oct 2025.',
    'Membrane has no mainnet deployment — its LTV parameters here are modelled.',
    'A simulation is not a forecast. membrane',
  ]
  foot.forEach((line, i) => g.fillText(line, M, H - 168 + i * 30))

  return cv.toDataURL('image/png')
}

export function downloadShareCard(cmp: Comparison, isDemo: boolean): void {
  const url = drawShareCard(cmp, isDemo)
  if (!url) return
  const a = document.createElement('a')
  a.href = url
  a.download = 'membrane-position-sim.png'
  document.body.appendChild(a)
  try {
    a.click()
  } catch {
    /* ignore */
  }
  document.body.removeChild(a)
}
