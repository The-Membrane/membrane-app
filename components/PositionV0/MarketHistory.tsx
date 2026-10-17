// Before an address is read (or when none of the read venues holds a position): venue-level
// analysis, never an empty personal section (DESIGN_RULES §5b). The same forecast the
// position block shows, for ETH and BTC at a few fall sizes, as small multiples: each cell
// is the chance with its 90% band, each row carries its horizon's confidence label.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'
import { confidenceOf, formatBand, formatChance, touchAtLevel } from '@/lib/position/touch'
import {
  HORIZON_IDS,
  HORIZON_WORDS,
  periodYears,
  shortSha,
  type HistoryAsset,
  type HorizonId,
  type TouchTable,
} from '@/lib/position/touchHistory'

import { TOUCH_TIME_GRID, readingLine, timeToTouch } from '@/lib/position/touchTime'

import { STALE_HATCH } from './forecastMarks'
import { TimeToTouchChart, type TimeChartState } from './TimeToTouchChart'
import { Credit, Headline, Kicker, Section, Small, StaleTag } from './primitives'
import { CAPS, TYPE } from './typeScale'
import { MARKET_LEVELS, forecastFooter } from './viewModel'

const CELL = { fontFamily: NEWS_FONT.mono, fontSize: { base: TYPE.label, md: TYPE.body }, py: '5px', px: '4px', textAlign: 'right' as const }
const HEAD = { ...CELL, ...CAPS, fontSize: TYPE.label, fontWeight: 700, color: NEWS.muted }

/** "4 of 5" checks held, or "no checks". */
const heldOf = (t: TouchTable, asset: HistoryAsset, h: HorizonId): string => {
  const c = t.assets[asset].fall[h].confidence
  return c.checks === 0 ? 'no checks' : `held ${c.held} of ${c.checks}`
}

/** "2024–26" from a span's own dates. */
const spanYears = (span: { from: string; to: string }): string =>
  `${span.from.slice(0, 4)}–${span.to.slice(2, 4)}`

const AssetTable: React.FC<{ t: TouchTable; asset: HistoryAsset; stale: boolean }> = ({ t, asset, stale }) => (
  <Box minW={0}>
    <Box
      as="table"
      w="100%"
      sx={{ borderCollapse: 'collapse' }}
      aria-label={`Chance ${asset} falls by at least ${MARKET_LEVELS.slice(0, -1).join(', ')} or ${MARKET_LEVELS[MARKET_LEVELS.length - 1]} percent`}
    >
      <Box as="thead">
        <Box as="tr" borderBottom={`1px solid ${NEWS.ruleStrong}`}>
          <Text as="th" {...HEAD} textAlign="left" pl={0} color={NEWS.ink}>
            {asset} falls
          </Text>
          {MARKET_LEVELS.map((L) => (
            <Text as="th" key={L} {...HEAD}>
              {L}%+
            </Text>
          ))}
          <Text as="th" {...HEAD} pr={0}>
            conf.
          </Text>
        </Box>
      </Box>
      <Box as="tbody">
        {HORIZON_IDS.map((h) => (
          <Box as="tr" key={h} borderBottom={`1px solid ${NEWS.rule}`}>
            <Text as="th" {...CELL} textAlign="left" pl={0} fontWeight={400} color={NEWS.ink2} scope="row" whiteSpace="nowrap">
              within {HORIZON_WORDS[h]}
            </Text>
            {MARKET_LEVELS.map((L) => {
              const f = touchAtLevel(t, asset, 'fall', h, L)
              return (
                <Text as="td" key={L} {...CELL} color={NEWS.ink} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                  {f && !stale ? formatChance(f.touched, f.n) : '—'}
                  {f && !stale && (
                    <Text as="span" display="block" fontSize={TYPE.label} color={NEWS.muted}>
                      {formatBand(f.lo, f.hi, f.n)}
                    </Text>
                  )}
                </Text>
              )
            })}
            <Text as="td" {...CELL} pr={0} fontSize={TYPE.label} color={NEWS.ink2}>
              {confidenceOf(t, asset, 'fall', h).label}
              <Text as="span" display="block" color={NEWS.muted}>
                {heldOf(t, asset, h)}
              </Text>
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  </Box>
)

/** The market chart's line: ETH falling the first market level (10%). */
const MARKET_TIME_LEVEL = MARKET_LEVELS[0]

/** The same time chart the position block draws, before any address: ETH falling 10%. */
const MarketTime: React.FC<{ t: TouchTable; stale: boolean }> = ({ t, stale }) => {
  const tt = timeToTouch(t, TOUCH_TIME_GRID, 'ETH', 'fall', MARKET_TIME_LEVEL)
  const state: TimeChartState = stale
    ? { kind: 'withheld', stale: true, reason: `history ends ${t.period.dataEnd.slice(0, 10)}` }
    : tt
      ? {
          kind: 'ready',
          series: [{ tt, tone: 'ink' }],
          marks: true,
          summary: `Chance ETH falls ${MARKET_TIME_LEVEL}% by each time from 1 hour to 7 days: ${readingLine(tt)}.`,
        }
      : { kind: 'withheld', reason: 'no table row' }
  return (
    <Box display="grid" gap={SPACING.xs} minW={0}>
      <Kicker tone="muted">ETH falls {MARKET_TIME_LEVEL}%, by when</Kicker>
      <TimeToTouchChart state={state} caption="chance touched by then" />
      {tt && !stale && <Small color={NEWS.ink2}>{readingLine(tt)}.</Small>}
    </Box>
  )
}

export const MarketHistory: React.FC<{ t: TouchTable; stale: boolean }> = ({ t, stale }) => (
  <Section id="market" bgImage={stale ? STALE_HATCH : undefined} data-stale={stale ? 'true' : undefined}>
    <Kicker>Forecast · {periodYears(t)} history†</Kicker>
    <Headline>Chance ETH or BTC falls from today</Headline>
    {stale && (
      <Small color={NEWS.ink2}>
        <StaleTag />: the history ends {t.period.dataEnd.slice(0, 10)}. No numbers shown.
      </Small>
    )}
    <MarketTime t={t} stale={stale} />
    <Box display="grid" gridTemplateColumns={{ base: '1fr', md: '1fr 1fr' }} gap={SPACING.lg} minW={0}>
      <AssetTable t={t} asset="ETH" stale={stale} />
      <AssetTable t={t} asset="BTC" stale={stale} />
    </Box>
    <Small>
      Under each chance, its likely range (90%). Confidence is preliminary: “held k of n” counts the fall sizes where{' '}
      {spanYears(t.period.test)} stayed inside the range {spanYears(t.period.calib)} gave.
    </Small>
    <Text fontFamily={NEWS_FONT.display} fontStyle="italic" fontSize={TYPE.body} color={NEWS.ink2}>
      Paste an address above for the chance at your own line.
    </Text>
    <Small>{forecastFooter(t, ['ETH', 'BTC'], 'fall')}</Small>
    <Credit>
      {t.assets.ETH.feed} and {t.assets.BTC.feed} hourly lows · membrane-datasets validation/t1 rows · {shortSha(t)}
    </Credit>
  </Section>
)
