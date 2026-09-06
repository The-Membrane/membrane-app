import { describe, expect, it } from 'vitest'

import {
  CARD_HEIGHT,
  CARD_WIDTH,
  FOOTER_LEFT,
  buildShareCardModel,
} from '@/components/Radar/radarShareCardModel'

// Contract test for the exported share card's content model (node — the
// embedded browser can't hydrate to click-test, and the toPng step is the same
// exportElementAsImage pipeline the ShareableCard flow already uses in
// production). What must hold: headline is the user's numbers, verdicts carry
// their colors, provenance footer + date self-document the image.

const venues = [
  { label: 'Aave', verdict: 'clear' as const, reason: 'instant liquidity covers your $2.1M 160x over' },
  { label: 'sUSDe', verdict: 'caution' as const, reason: 'your exit sits behind a 1d cooldown' },
  { label: 'scrvUSD', verdict: 'exposed' as const, reason: 'no single day has moved your size' },
]

describe('radar share card model', () => {
  const model = buildShareCardModel({
    totalUsdText: '$3.1M',
    heldCount: 2,
    venues,
    dateText: '2026-09-06',
  })

  it('is the feed shape', () => {
    expect(CARD_WIDTH).toBe(1200)
    expect(CARD_HEIGHT).toBe(675)
  })

  it('headline is the user’s numbers', () => {
    expect(model.headline).toBe('$3.1M across 2 venues — can it get out?')
  })

  it('each verdict carries its color', () => {
    expect(model.rows.map((r) => [r.verdict, r.color])).toEqual([
      ['clear', '#9bdc4f'],
      ['caution', '#d8b24a'],
      ['exposed', '#cf4034'],
    ])
    expect(model.rows[1].reason).toContain('1d cooldown')
  })

  it('self-documents: provenance footer + date', () => {
    expect(model.footerLeft).toBe(FOOTER_LEFT)
    expect(model.footerRight).toBe('2026-09-06')
  })

  it('singular venue reads naturally', () => {
    const one = buildShareCardModel({
      totalUsdText: '$40k',
      heldCount: 1,
      venues: venues.slice(0, 1),
      dateText: '2026-09-06',
    })
    expect(one.headline).toBe('$40k across 1 venue — can it get out?')
  })

  it('caps at four rows for legibility', () => {
    const many = buildShareCardModel({
      totalUsdText: '$1M',
      heldCount: 6,
      venues: [...venues, ...venues],
      dateText: '2026-09-06',
    })
    expect(many.rows).toHaveLength(4)
  })
})
