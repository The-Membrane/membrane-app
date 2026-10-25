// THE FORECAST LAYER. Three columns, each a short label and its numbers. Each reading is
// shown only as its registry cell allows: a probability with its class label (shortest
// form on the page, the engine's full label in the tooltip), a history count (never a %),
// nothing where the cell says DO NOT SHOW. Explanations live in the one Details below.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { fmtLocalDayClock, useLocalZone } from '@/components/Simulator/localClock'
import {
  fmtHorizon,
  shortClass,
  shown,
  type DelayStep,
  type ForwardReach,
  type HistoryReading,
  type Shown,
  type Slot,
} from '@/lib/landing/forecastLayer'

import Details, { DetailLine } from './Details'
import { credit, kicker, rule, small, tabularNums } from './styles'

export interface ForecastPanelProps {
  delay: Slot<DelayStep[]>
  history: Slot<HistoryReading[]>
  reach: Slot<ForwardReach>
  isDemo: boolean
  /** "Binance spot 1h klines · fetched HH:MM", once a series has loaded. */
  stamp: string | null
}

const Pending: React.FC<{ reason: string }> = ({ reason }) => (
  <Text {...small} data-testid="forecast-pending" title={reason}>
    Model pending
  </Text>
)

/**
 * One reading: "3d · −7% · 23%  calibrated · not proven better". An upper bound (the
 * line is deeper than the nearest shown level) is written "≥ −7%": at least as far as.
 */
const ShownLine: React.FC<{ s: Shown; upperBound?: boolean }> = ({ s, upperBound }) => {
  if (s.kind === 'none') return null
  return (
    <Text {...small} {...tabularNums} color={SEMANTIC_COLORS.textPrimary}>
      {s.kind === 'probability' ? (
        <>
          {fmtHorizon(s.horizonH)} · {upperBound ? '≥ ' : ''}−{Math.abs(s.levelPct)}% · {s.text}{' '}
          <Text as="span" color={SEMANTIC_COLORS.textSecondary} title={[s.label, s.caveat].filter(Boolean).join(' · ')}>
            {shortClass(s.cls, s.label)}
          </Text>
        </>
      ) : (
        <Text as="span" title={s.label}>
          {s.text}
        </Text>
      )}
    </Text>
  )
}

const Block: React.FC<{ title: string; testId: string; children: React.ReactNode }> = ({ title, testId, children }) => (
  <Box data-testid={testId} display="grid" gap={SPACING.xs} borderTop={rule} pt={SPACING.sm} minW={0} alignContent="start">
    <Text {...kicker}>{title}</Text>
    {children}
  </Box>
)

export const ForecastPanel: React.FC<ForecastPanelProps> = ({ delay, history, reach, stamp, isDemo }) => {
  const zone = useLocalZone()
  const caveats = new Set<string>()
  const collect = (r: Shown) => {
    if (r.kind === 'probability') {
      caveats.add(r.label)
      if (r.caveat) caveats.add(r.caveat)
    }
  }
  return (
    <Box as="section" aria-label="Forecast layer" data-testid="landing-forecast" display="grid" gap={SPACING.md}>
      <Box display="grid" gap={SPACING.md} gridTemplateColumns={{ base: 'minmax(0, 1fr)', lg: 'repeat(3, minmax(0, 1fr))' }}>
        <Block title="In the window" testId="forecast-delay">
          {delay.status === 'pending' ? (
            <Pending reason={delay.reason} />
          ) : (
            delay.value.map((step) => {
              const rows = (step.reach?.rows ?? []).filter((row) => shown(row.result).kind !== 'none').slice(0, 3)
              rows.forEach((row) => collect(shown(row.result)))
              return (
                <Box key={step.minute}>
                  <Text {...small} {...tabularNums}>
                    {fmtLocalDayClock(step.ts, zone)} ·{' '}
                    {step.alreadyPast
                      ? 'already past the sale point'
                      : step.toBreakPct === null
                        ? 'no price'
                        : `sale point −${Math.floor(Math.abs(step.toBreakPct))}%`}
                  </Text>
                  {!step.alreadyPast && step.toBreakPct !== null &&
                    rows.map((row) => <ShownLine key={row.horizonH} s={shown(row.result)} upperBound={row.isUpperBound} />)}
                </Box>
              )
            })
          )}
        </Block>

        <Block title={isDemo ? 'Its history' : 'Your history'} testId="forecast-history">
          {history.status === 'pending' ? (
            <Pending reason={history.reason} />
          ) : (
            history.value.map((h) => {
              h.results.forEach(collect)
              return (
                <Box key={h.episodeStartTs}>
                  <Text {...small} {...tabularNums}>
                    {fmtLocalDayClock(h.episodeStartTs, zone)} · {h.collateral} · liquidated
                  </Text>
                  {h.results.slice(0, 3).map((s, k) => (
                    <ShownLine key={k} s={s} />
                  ))}
                </Box>
              )
            })
          )}
        </Block>

        <Block title="From today" testId="forecast-reach">
          {reach.status === 'pending' ? (
            <Pending reason={reach.reason} />
          ) : reach.value.reach.throughLine ? (
            <Text {...small} color={SEMANTIC_COLORS.textPrimary} data-testid="forecast-act-now">
              {isDemo ? 'Demo position: through its line at today’s price. Act now.' : 'Through your line at today’s price. Act now.'}
            </Text>
          ) : (
            <>
              <Text {...small} {...tabularNums}>
                {isDemo ? 'Demo line' : 'Your line'} −{Math.floor(Math.abs(reach.value.distancePct ?? 0))}% from spot
              </Text>
              {reach.value.reach.rows
                .filter((row) => row.status === 'inside')
                .map((row) => {
                  collect(shown(row.result))
                  return <ShownLine key={row.horizonH} s={shown(row.result)} upperBound={row.isUpperBound} />
                })}
              {reach.value.reach.rows.some((row) => row.status === 'beyond') && (
                <Text {...small} {...tabularNums}>
                  {reach.value.reach.rows
                    .filter((row) => row.status === 'beyond')
                    .map((row) => fmtHorizon(row.horizonH))
                    .join(' · ')}
                  : out of range
                </Text>
              )}
            </>
          )}
        </Block>
      </Box>
      {stamp && <Text {...credit} textAlign="left">{stamp}</Text>}
      <Details testId="forecast-details">
        <DetailLine>
          † Forecasts are of the Binance spot price touching a level within a horizon, not of your venue’s oracle. Each reading
          shows only what its registry cell allows (Q26 confidence map); not a guarantee. “≥ −X%” is the nearest level the
          model may show, an upper bound for a deeper line. “In the window” reads each hour of the armed {''}
          window from the engine’s spot; “From today” uses the position’s amounts at the latest spot.
        </DetailLine>
        {Array.from(caveats).map((c) => (
          <DetailLine key={c}>{c}</DetailLine>
        ))}
        {delay.status === 'pending' && <DetailLine>In the window: {delay.reason}</DetailLine>}
        {history.status === 'pending' && <DetailLine>History: {history.reason}</DetailLine>}
        {reach.status === 'pending' && <DetailLine>From today: {reach.reason}</DetailLine>}
      </Details>
    </Box>
  )
}

export default ForecastPanel
