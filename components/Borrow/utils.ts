/**
 * Pure math/formatting helpers ported from public/proto/borrow.html's inline
 * <script>. The proto's 12-month breach-odds formula (zero-drift GBM touch
 * probability) was removed (Q26 S1): it was never graded against realized
 * outcomes, and the page must not show an uncalibrated probability. Its
 * replacement is the scored Q26 touch forecast (O-borrow-1), once it exists.
 */
import type { CollateralAsset, EmphasisKind } from './types'

/** '$' + rounded, thousands-separated — matches the proto's fmt(n). */
export function fmt(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US')
}

/** Locale-formatted asset amount, clamped to the asset's display decimal places. */
export function fmtAmount(n: number, dp: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: dp })
}

/** Half the wallet balance, pre-rounded to the asset's decimals (capped at 4dp) — the proto's default post amount. */
export function defaultPostAmount(asset: Pick<CollateralAsset, 'bal' | 'dp'>): string {
  return (asset.bal / 2).toFixed(Math.min(asset.dp, 4))
}

/** Parses a free-typed amount field the same way the proto's post() did: strip non-numerics, default 0. */
export function parseAmountInput(raw: string): number {
  return parseFloat((raw || '0').replace(/[^0-9.]/g, '')) || 0
}

export interface BorrowMath {
  /** Collateral amount typed into the post field. */
  postValue: number
  /** USD value of the posted collateral. */
  pv: number
  /** CDT minted at the effective LTV. */
  mint: number
  /** The asset's borrow cap, as a whole percent (rounded, matches the proto's slider max). */
  ltvCapPercent: number
  /** The slider's LTV, clamped to the cap — this is what all the math below uses. */
  effectiveLtv: number
  /** Net carry: collateral yield minus the borrow rate, percent/yr. */
  net: number
}

/** All the derived borrow-form numbers in one place, so the panel and the confirm sheet never drift apart. */
export function computeBorrowMath(
  asset: CollateralAsset,
  postAmountRaw: string,
  ltv: number,
  rate: number
): BorrowMath {
  const ltvCapPercent = Math.round(asset.B * 100)
  const effectiveLtv = Math.min(ltv, ltvCapPercent)
  const postValue = parseAmountInput(postAmountRaw)
  const pv = postValue * asset.px
  const mint = (pv * effectiveLtv) / 100
  const net = asset.yld - rate
  return { postValue, pv, mint, ltvCapPercent, effectiveLtv, net }
}

export interface EmphasisSegment {
  text: string
  emphasis?: EmphasisKind
}

const EMPHASIS_RE = /<b class="(does|not|mut)">(.*?)<\/b>/g

/**
 * Splits oracle-card copy on the proto's inline `<b class="does|not|mut">`
 * spans into plain/emphasized text segments, so the copy can be rendered as
 * real React nodes (colored via SEMANTIC_COLORS) instead of raw HTML.
 */
export function parseEmphasisMarkup(markup: string): EmphasisSegment[] {
  const segments: EmphasisSegment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  EMPHASIS_RE.lastIndex = 0
  while ((match = EMPHASIS_RE.exec(markup))) {
    if (match.index > lastIndex) segments.push({ text: markup.slice(lastIndex, match.index) })
    segments.push({ text: match[2], emphasis: match[1] as EmphasisKind })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < markup.length) segments.push({ text: markup.slice(lastIndex) })
  return segments
}
