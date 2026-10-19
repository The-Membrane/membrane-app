// Before an address is read (or when none of the read venues holds a position): venue-level
// analysis, never an empty personal section (DESIGN_RULES §5b). The same forecast the
// position block shows, for ETH and BTC at a few fall sizes, as small multiples: each cell
// is the chance with its 90% band, each row carries its horizon's confidence label.

import React, { useState } from 'react'
import { Box, Button, Text } from '@chakra-ui/react'

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

import { TRANSITIONS } from '@/config/transitions'
import { GRID_DEPTH, touchGrid } from '@/lib/position/touchGrid'
import { TOUCH_TIME_GRID, readingLine, timeToTouch } from '@/lib/position/touchTime'

import { STALE_HATCH } from './forecastMarks'
import { TimeToTouchChart, type TimeChartState } from './TimeToTouchChart'
import { TouchGridChart, type GridChartState } from './TouchGridChart'
import { Credit, Headline, Kicker, Section, Small, StaleTag } from './primitives'
import { CAPS, TYPE, BODY_MD } from './typeScale'
import { MARKET_LEVELS, forecastFooter } from './viewModel'

const CELL = { fontFamily: NEWS_FONT.mono, fontSize: { base: TYPE.label, md: BODY_MD }, py: '5px', px: '4px', textAlign: 'right' as const }
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

/** The market chart's default read-out: the first market level (10%), at 7 days. */
const MARKET_TIME_LEVEL = MARKET_LEVELS[0]

/** The assets both the forecast table and the touch-time grid cover: the toggle's options. */
export const marketAssets = (t: TouchTable): HistoryAsset[] =>
  (Object.keys(t.assets) as HistoryAsset[]).filter((a) => TOUCH_TIME_GRID.assets[a] !== undefined)

/** The market grid's state, before any address: the default rows, no reader's row. Pure. */
export function marketGridState(t: TouchTable, asset: HistoryAsset, stale: boolean): GridChartState {
  if (stale) return { kind: 'withheld', stale: true, reason: `history ends ${t.period.dataEnd.slice(0, 10)}` }
  const grid = touchGrid(t, TOUCH_TIME_GRID, asset, 'fall', GRID_DEPTH)
  return {
    kind: 'ready',
    grid,
    you: null,
    levers: [],
    initial: { level: MARKET_TIME_LEVEL, hours: 168 },
    summary: `Chance ${asset} falls ${GRID_DEPTH.from}% to ${GRID_DEPTH.to}% by each time from 1 hour to 7 days.`,
  }
}

/** The round-3 time chart (?charts=two): the asset falling 10%. */
const MarketTime: React.FC<{ t: TouchTable; stale: boolean; asset: HistoryAsset }> = ({ t, stale, asset }) => {
  const tt = timeToTouch(t, TOUCH_TIME_GRID, asset, 'fall', MARKET_TIME_LEVEL)
  const state: TimeChartState = stale
    ? { kind: 'withheld', stale: true, reason: `history ends ${t.period.dataEnd.slice(0, 10)}` }
    : tt
      ? {
          kind: 'ready',
          series: [{ tt, tone: 'ink' }],
          marks: true,
          summary: `Chance ${asset} falls ${MARKET_TIME_LEVEL}% by each time from 1 hour to 7 days: ${readingLine(tt)}.`,
        }
      : { kind: 'withheld', reason: 'no table row' }
  return (
    <Box display="grid" gap={SPACING.xs} minW={0}>
      <Kicker tone="muted">{asset} falls {MARKET_TIME_LEVEL}%, by when</Kicker>
      <TimeToTouchChart state={state} caption="chance touched by then" />
      {tt && !stale && <Small color={NEWS.ink2}>{readingLine(tt)}.</Small>}
    </Box>
  )
}

/** ETH / BTC: one per asset the tables cover. */
const AssetToggle: React.FC<{ assets: HistoryAsset[]; value: HistoryAsset; onChange: (a: HistoryAsset) => void }> = ({ assets, value, onChange }) => (
  <Box role="group" aria-label="Asset" display="flex" columnGap={SPACING.base} minW={0}>
    {assets.map((a) => {
      const on = a === value
      return (
        <Button
          key={a}
          type="button"
          variant="unstyled"
          aria-pressed={on}
          onClick={() => onChange(a)}
          h="44px"
          minW="44px"
          w="auto"
          flex="none"
          px={0}
          fontFamily={NEWS_FONT.mono}
          fontSize={TYPE.label}
          fontWeight={700}
          {...CAPS}
          color={on ? NEWS.ink : NEWS.muted}
          borderRadius={0}
          borderBottom={`2px solid ${on ? NEWS.ink : 'transparent'}`}
          transition={TRANSITIONS.colors}
          _hover={{ color: NEWS.ink }}
          _focusVisible={{ outline: `2px solid ${NEWS.ink}`, outlineOffset: '2px' }}
        >
          {a}
        </Button>
      )
    })}
  </Box>
)

const MarketChart: React.FC<{ t: TouchTable; stale: boolean; two: boolean }> = ({ t, stale, two }) => {
  const assets = marketAssets(t)
  const [asset, setAsset] = useState<HistoryAsset>(assets[0] ?? 'ETH')
  return (
    <Box display="grid" gap={SPACING.xs} minW={0}>
      {assets.length > 1 && <AssetToggle assets={assets} value={asset} onChange={setAsset} />}
      {two ? (
        <MarketTime t={t} stale={stale} asset={asset} />
      ) : (
        <>
          <Kicker tone="muted">{asset} falls, by when and how far</Kicker>
          <TouchGridChart key={asset} state={marketGridState(t, asset, stale)} />
        </>
      )}
    </Box>
  )
}

export const MarketHistory: React.FC<{ t: TouchTable; stale: boolean; two?: boolean; ageLine?: string | null }> = ({
  t,
  stale,
  two = false,
  ageLine = null,
}) => (
  <Section id="market" bgImage={stale ? STALE_HATCH : undefined} data-stale={stale ? 'true' : undefined}>
    <Kicker>Forecast · {periodYears(t)} history†</Kicker>
    <Headline>Chance ETH or BTC falls from today</Headline>
    {stale && (
      <Small color={NEWS.ink2}>
        <StaleTag />: the history ends {t.period.dataEnd.slice(0, 10)}. No numbers shown.
      </Small>
    )}
    <MarketChart t={t} stale={stale} two={two} />
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
    {ageLine && <Credit data-age-line="">{ageLine}</Credit>}
  </Section>
)
