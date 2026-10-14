// THE HERO (DESIGN_RULES §6): the decisive absolute value in the reader's unit, with its
// distance from now. One $ figure, one source, one sentence. No verdict words (§4).

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { NEWS, NEWS_FIGURE, NEWS_FONT } from '@/components/NewsEdition/tokens'
import { fmtUsd } from '@/lib/position/format'

import { Kicker, Mono } from './primitives'
import { TYPE } from './typeScale'
import type { PositionView } from './viewModel'

const Figure: React.FC<{ children: React.ReactNode; color?: string }> = ({ children, color = NEWS.ink }) => (
  <Text
    as="span"
    {...NEWS_FIGURE.display}
    fontSize={TYPE.hero}
    lineHeight={1.05}
    color={color}
    whiteSpace="nowrap"
  >
    {children}
  </Text>
)

/** The leading words of the headline, in Redaction at section size. */
const Lead: React.FC<{ children: React.ReactNode; color?: string }> = ({ children, color = NEWS.ink }) => (
  <Text as="span" display="block" fontFamily={NEWS_FONT.display} fontWeight={700} fontSize={TYPE.head} lineHeight={1.2} color={color}>
    {children}
  </Text>
)

export const Hero: React.FC<{ view: PositionView }> = ({ view }) => {
  const { hero, priceSource, assumption } = view
  const venue = view.label.split(' · ')[0]
  const dagger = assumption ? '†' : ''

  let headline: React.ReactNode
  let sub: string
  let sentence: string
  switch (hero.kind) {
    case 'line': {
      const where = hero.direction === 'fall' ? 'below' : 'above'
      const dist = hero.distancePct === 0 ? `under 1% ${where} now` : `${hero.distancePct}% ${where} now`
      headline = (
        <>
          <Lead>{hero.symbol} liquidation price</Lead>
          <Figure>
            {fmtUsd(hero.priceShown, hero.decimals)}
            {dagger}
          </Figure>
        </>
      )
      sub = `${dist} · ${priceSource}`
      sentence = hero.direction === 'fall' ? `Below it, ${venue} can liquidate you.` : `Above it, ${venue} can liquidate you.`
      break
    }
    case 'past':
      headline = (
        <>
          <Lead color={NEWS.danger}>✖ Past the liquidation line</Lead>
          <Figure color={NEWS.danger}>HF {hero.healthFactor.toFixed(2)}</Figure>
        </>
      )
      sub = `health factor under 1 · ${priceSource}`
      sentence = `${venue} can liquidate it now.`
      break
    case 'unreachable':
      headline = <Lead>No {hero.symbol} price reaches the line</Lead>
      sub = `the other legs cover the debt · ${priceSource}`
      sentence = `A ${hero.symbol} fall alone cannot liquidate it.`
      break
    case 'no-debt':
      headline = (
        <>
          <Lead>No debt, no liquidation line</Lead>
          <Figure>{fmtUsd(view.metrics.collateralUsd)}</Figure>
        </>
      )
      sub = `collateral · ${priceSource}`
      sentence = 'Nothing here can be liquidated.'
      break
  }

  return (
    <Box as="header" data-news-section="hero" display="grid" gap={SPACING.sm} pt={SPACING.lg} minW={0} aria-live="polite">
      <Kicker tone="muted">{view.title}</Kicker>
      <Text as="h1" m={0} display="grid" gap={SPACING.xs}>
        {headline}
      </Text>
      <Mono color={NEWS.ink2}>{sub}</Mono>
      <Text fontFamily={NEWS_FONT.display} fontStyle="italic" fontSize={TYPE.body} lineHeight={1.4} color={NEWS.ink2}>
        {sentence}
      </Text>
    </Box>
  )
}
