// THE HERO (DESIGN_RULES §6): the decisive absolute value in the reader's unit, with its
// distance from now. One $ figure, one source, one sentence. No verdict words (§4).

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { NEWS, NEWS_FIGURE, NEWS_FONT } from '@/components/NewsEdition/tokens'
import { fmtAmount, fmtUsd } from '@/lib/position/format'
import { priceDecimals } from '@/lib/position/liquidation'

import { Dagger, Kicker, Mono } from './primitives'
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

interface HeroCopy {
  lead: string
  /** The big figure, already formatted; null when the headline is words only. */
  figure: string | null
  dagger: boolean
  danger: boolean
  sub: string
  sentence: string
}

type Hero = PositionView['hero']

/** The line hero: a USD price, or a price RATIO when collateral and debt share a family. */
function lineCopy(hero: Extract<Hero, { kind: 'line' }>, venue: string, priceSource: string, dagger: boolean): HeroCopy {
  const where = hero.direction === 'fall' ? 'below' : 'above'
  const dist = hero.distancePct === 0 ? `under 1% ${where} now` : `${hero.distancePct}% ${where} now`
  if (hero.unit.kind === 'ratio') {
    const { base, quote } = hero.unit
    return {
      lead: `${base}/${quote} liquidation line`,
      figure: hero.priceShown.toFixed(hero.decimals),
      dagger,
      danger: false,
      sub: `${dist} · ${priceSource}, ${base} ÷ ${quote}`,
      sentence: `${hero.direction === 'fall' ? 'Below' : 'Above'} this ratio, ${venue} can liquidate you.`,
    }
  }
  return {
    lead: `${hero.symbol} liquidation price`,
    figure: fmtUsd(hero.priceShown, hero.decimals),
    dagger,
    danger: false,
    sub: `${dist} · ${priceSource}`,
    sentence: `${hero.direction === 'fall' ? 'Below' : 'Above'} it, ${venue} can liquidate you.`,
  }
}

/** An oracle-terms quantity: compact past a million (the $4.7T oracle), else 4 significant figures. */
const fmtQuote = (x: number) =>
  x >= 1e6
    ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 4 }).format(x)
    : fmtAmount(x, priceDecimals(x))

/**
 * The line of a position whose collateral oracle failed its market check, in the ORACLE'S
 * own terms (its quote token per collateral token), never as a market price.
 */
function oracleLineCopy(view: PositionView, hero: Extract<Hero, { kind: 'line' }>, venue: string): HeroCopy | null {
  const flag = view.oracleFlag
  if (!flag?.line) return null
  const { check } = flag
  const where = hero.direction === 'fall' ? 'below' : 'above'
  const dist = hero.distancePct === 0 ? `under 1% ${where}` : `${hero.distancePct}% ${where}`
  const verdict = check.status === 'disagrees' ? 'oracle price disagrees with market' : 'oracle price unchecked'
  return {
    lead: `${check.symbol} line in the oracle's terms`,
    figure: `${fmtQuote(flag.line.value)} ${check.quote}`,
    dagger: false,
    danger: false,
    sub: `per ${check.symbol} · ${dist} the oracle's ${fmtQuote(flag.line.now)} · ${verdict}`,
    sentence:
      check.status === 'disagrees'
        ? `The market prices ${check.symbol} at ${fmtUsd(check.referenceUsd as number, priceDecimals(check.referenceUsd as number))} (${check.referenceSource}); ${venue} liquidates on this oracle, so no forecast is drawn on it.`
        : `No market price was found to check this oracle against, so no forecast is drawn on it.`,
  }
}

/** What the hero says, per kind. Pure. */
function heroCopy(view: PositionView): HeroCopy {
  const { hero, priceSource, assumption } = view
  const venue = view.label.split(' · ')[0]
  const plain = { dagger: false, danger: false }
  // A failed oracle check is named on every hero that quotes the oracle.
  const flagged = view.oracleFlag ? ` · ${view.oracleFlag.check.status === 'disagrees' ? 'oracle price disagrees with market' : 'oracle price unchecked'}` : ''
  switch (hero.kind) {
    case 'line': {
      const oracle = oracleLineCopy(view, hero, venue)
      if (oracle) return oracle
      const copy = lineCopy(hero, venue, priceSource, Boolean(assumption))
      return { ...copy, sub: `${copy.sub}${flagged}` }
    }
    case 'unsplit': {
      // The legs could not reproduce the protocol's thresholds: only its own figure is shown.
      const under = hero.healthFactor <= 1
      return {
        ...plain,
        danger: under,
        lead: under ? '✖ Health factor under 1' : 'Health factor',
        figure: hero.healthFactor.toFixed(3),
        sub: `${venue}'s own figure`,
        sentence: 'Thresholds could not be split per asset.',
      }
    }
    case 'past':
      return {
        ...plain,
        danger: true,
        lead: '✖ Past the liquidation line',
        figure: `HF ${hero.healthFactor.toFixed(2)}`,
        sub: `health factor under 1 · ${priceSource}${flagged}`,
        sentence: `${venue} can liquidate it now.`,
      }
    case 'unreachable': {
      if (hero.cause === 'interest') {
        // The same asset on both sides: health factor is the same at every price.
        return {
          ...plain,
          lead: 'No price move reaches this line',
          figure: null,
          sub: `${hero.symbol} on both sides · ${priceSource}`,
          sentence: 'Only interest does.',
        }
      }
      const what = hero.unit.kind === 'ratio' ? `${hero.unit.base}/${hero.unit.quote} ratio` : `${hero.symbol} price`
      return {
        ...plain,
        lead: `No ${what} reaches the line`,
        figure: null,
        sub: `the other legs cover the debt · ${priceSource}`,
        sentence: `A ${hero.symbol} ${hero.direction} alone cannot liquidate it.`,
      }
    }
    case 'no-debt': {
      // A lender's position: no line of its own, but not beyond loss — Morpho writes bad debt
      // left by a borrower's liquidation off against the market's supply.
      const supplied = view.position.supplied ?? []
      if (view.position.status === 'supply-only' && supplied.length > 0) {
        return {
          ...plain,
          lead: 'Lending only: no liquidation line',
          figure: fmtUsd(supplied.reduce((s, x) => s + x.valueUsd, 0)),
          sub: `supplied ${supplied.map((x) => x.symbol).join(' + ')} · ${priceSource}`,
          sentence: 'Bad debt in this market is shared by lenders.',
        }
      }
      return {
        ...plain,
        lead: 'No debt, no liquidation line',
        figure: fmtUsd(view.metrics.collateralUsd),
        sub: `collateral · ${priceSource}`,
        sentence: 'Nothing here can be liquidated.',
      }
    }
  }
}

export const Hero: React.FC<{ view: PositionView }> = ({ view }) => {
  const c = heroCopy(view)
  const tone = c.danger ? NEWS.danger : NEWS.ink
  return (
    <Box as="header" data-news-section="hero" display="grid" gap={SPACING.xs} pt={SPACING.md} minW={0} aria-live="polite">
      <Kicker tone="muted">{view.title}</Kicker>
      <Text as="h1" m={0} display="grid" gap={SPACING.xs}>
        <Lead color={tone}>{c.lead}</Lead>
        {c.figure !== null && (
          <Figure color={tone}>
            {c.figure}
            {c.dagger && <Dagger />}
          </Figure>
        )}
      </Text>
      <Mono color={NEWS.ink2}>{c.sub}</Mono>
      <Text fontFamily={NEWS_FONT.display} fontStyle="italic" fontSize={TYPE.body} lineHeight={1.4} color={NEWS.ink2}>
        {c.sentence}
      </Text>
    </Box>
  )
}
