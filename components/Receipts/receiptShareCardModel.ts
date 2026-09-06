// Pure content model for the Called-It receipt share card — JSX-free so the node
// test suite exercises it directly (same shell/model split as radarShareCardModel:
// ReceiptShareCard.tsx is a thin visual shell over this).
//
// A receipt card is only ever rendered for a SCORED call. The verdict is HIT or
// MISS, stated at full volume — a MISS is never softened, hedged, or reframed as
// "close". Failure stays unambiguous (that honesty IS the product's credibility).

import { fmtStatementUsd } from './receiptLogic'

export const CARD_WIDTH = 1200
export const CARD_HEIGHT = 675
export const FOOTER_LEFT = 'scored by the membrane recorder'

export const HIT_COLOR = '#9bdc4f'
export const MISS_COLOR = '#cf4034'

export type ReceiptVerdict = 'HIT' | 'MISS'

export interface ReceiptCardModel {
  eyebrow: string
  headline: string // the canonical statement — the call, verbatim
  verdict: ReceiptVerdict
  verdictColor: string
  outcomeLine: string // realized value vs the stated band
  footerLeft: string
  footerRight: string // scored_at
}

export function buildReceiptCardModel(input: {
  statement: string
  hit: boolean
  realized: number
  bandLow: number
  bandHigh: number
  scoredAtText: string
}): ReceiptCardModel {
  const { statement, hit, realized, bandLow, bandHigh, scoredAtText } = input
  const band = `${fmtStatementUsd(bandLow)}–${fmtStatementUsd(bandHigh)}`
  return {
    eyebrow: 'Membrane Called-It · a signed call, scored',
    headline: statement,
    verdict: hit ? 'HIT' : 'MISS',
    verdictColor: hit ? HIT_COLOR : MISS_COLOR,
    // Plain statement of fact either way. On a MISS this reads "realized $X vs
    // band $lo–$hi" — the number that fell outside is right there, unhedged.
    outcomeLine: `realized ${fmtStatementUsd(realized)} vs band ${band}`,
    footerLeft: FOOTER_LEFT,
    footerRight: scoredAtText,
  }
}
