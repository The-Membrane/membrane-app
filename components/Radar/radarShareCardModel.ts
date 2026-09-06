// Pure content model for the radar share card — JSX-free so the node test
// suite exercises it directly (repo convention: radarLogic / venueLogLogic /
// newsParse). RadarShareCard.tsx is a thin visual shell over this.

export type ShareCardVenue = {
  label: string
  verdict: 'clear' | 'caution' | 'exposed'
  reason: string
}

export const VERDICT_COLOR: Record<ShareCardVenue['verdict'], string> = {
  clear: '#9bdc4f',
  caution: '#d8b24a',
  exposed: '#cf4034',
}

export const CARD_WIDTH = 1200
export const CARD_HEIGHT = 675
export const FOOTER_LEFT = 'membrane carry radar · recorded corpus'

export interface ShareCardModel {
  eyebrow: string
  headline: string
  rows: Array<ShareCardVenue & { color: string }>
  footerLeft: string
  footerRight: string
}

export function buildShareCardModel(input: {
  totalUsdText: string
  heldCount: number
  venues: ShareCardVenue[]
  dateText: string
}): ShareCardModel {
  const { totalUsdText, heldCount, venues, dateText } = input
  return {
    eyebrow: 'Carry Radar · exit stress, on the record',
    headline: `${totalUsdText} across ${heldCount} venue${heldCount === 1 ? '' : 's'} — can it get out?`,
    // Feed cards cap at four rows; the page shows everything, the image shows
    // the four that fit legibly.
    rows: venues.slice(0, 4).map((v) => ({ ...v, color: VERDICT_COLOR[v.verdict] })),
    footerLeft: FOOTER_LEFT,
    footerRight: dateText,
  }
}
