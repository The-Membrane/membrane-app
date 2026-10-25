// THE FORECAST LAYER. Three readings from the forecast engine (lib/forecast), each shown
// only as its registry cell allows: a probability with its label where the class permits
// one, a history count (never a %) where it does not, nothing where the cell says DO NOT
// SHOW. Horizons are whatever the registry lists. Until the engine is implemented each
// slot says "model pending" and prints no number.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { fmtLocalDayClock, useLocalZone } from '@/components/Simulator/localClock'
import type { ReachResult } from '@/lib/forecast'
import {
  fmtHorizon,
  shown,
  type DelayStep,
  type HistoryReading,
  type Shown,
  type Slot,
} from '@/lib/landing/forecastLayer'

import { credit, kicker, rule, small, tabularNums } from './styles'

export interface ForecastPanelProps {
  delay: Slot<DelayStep[]>
  history: Slot<HistoryReading[]>
  reach: Slot<ReachResult>
  /** "Binance spot 1h klines · fetched HH:MM", once a series has loaded. */
  stamp: string | null
}

const Pending: React.FC<{ reason: string }> = ({ reason }) => (
  <Text {...small} data-testid="forecast-pending">
    Model pending · no numbers shown <Text as="span" color={SEMANTIC_COLORS.textTertiary}>({reason})</Text>
  </Text>
)

/**
 * One engine reading. A probability names its horizon and level: "within 3d, price
 * touches −10%". An upper bound (the line sits deeper than the nearest shown level) says
 * "at least as far as −X%", never the line itself. A count is a count, never a %.
 */
const ShownLine: React.FC<{ s: Shown; upperBound?: boolean }> = ({ s, upperBound }) => {
  if (s.kind === 'none') return null
  return (
    <Text {...small} {...tabularNums} color={SEMANTIC_COLORS.textPrimary}>
      {s.kind === 'probability' ? (
        <>
          within {fmtHorizon(s.horizonH)}, price touches {upperBound ? 'at least as far as ' : ''}−{Math.abs(s.levelPct)}%: {s.text}{' '}
          <Text as="span" color={SEMANTIC_COLORS.textSecondary}>
            † {s.label}
            {s.caveat ? ` · ${s.caveat}` : ''}
          </Text>
        </>
      ) : (
        <>
          {s.text}{' '}
          <Text as="span" color={SEMANTIC_COLORS.textSecondary}>
            {s.label}
          </Text>
        </>
      )}
    </Text>
  )
}

const Block: React.FC<{ title: string; testId: string; children: React.ReactNode }> = ({ title, testId, children }) => (
  <Box data-testid={testId} display="grid" gap={SPACING.xs} borderTop={rule} pt={SPACING.sm} minW={0}>
    <Text {...kicker}>{title}</Text>
    {children}
  </Box>
)

export const ForecastPanel: React.FC<ForecastPanelProps> = ({ delay, history, reach, stamp }) => {
  const zone = useLocalZone()
  return (
    <Box as="section" aria-label="Forecast layer" display="grid" gap={SPACING.md} gridTemplateColumns={{ base: '1fr', lg: 'repeat(3, minmax(0, 1fr))' }}>
      <Block title="Inside the 8h window · what the model would have said" testId="forecast-delay">
        {delay.status === 'pending' ? (
          <Pending reason={delay.reason} />
        ) : (
          delay.value.map((step) => {
            const rows = step.reach.rows.filter((row) => shown(row.result).kind !== 'none').slice(0, 3)
            return (
              <Box key={step.minute}>
                <Text {...small} {...tabularNums}>
                  {fmtLocalDayClock(step.ts, zone)} · sale point {Math.abs(Math.floor(step.toBreakPct))}% below
                </Text>
                {rows.length === 0 ? (
                  <Text {...small} color={SEMANTIC_COLORS.textTertiary}>nothing the model may show at this distance</Text>
                ) : (
                  rows.map((row) => <ShownLine key={row.horizonH} s={shown(row.result)} upperBound={row.isUpperBound} />)
                )}
              </Box>
            )
          })
        )}
      </Block>

      <Block title="Your own history · reading vs what followed" testId="forecast-history">
        {history.status === 'pending' ? (
          <Pending reason={history.reason} />
        ) : (
          history.value.map((h) => (
            <Box key={h.episodeStartTs}>
              <Text {...small} {...tabularNums}>
                {fmtLocalDayClock(h.episodeStartTs, zone)} · {h.collateral} · liquidated
              </Text>
              {h.results.map((s, k) => (
                <ShownLine key={k} s={s} />
              ))}
            </Box>
          ))
        )}
      </Block>

      <Block title="From today · how far the model reaches" testId="forecast-reach">
        {reach.status === 'pending' ? (
          <Pending reason={reach.reason} />
        ) : reach.value.throughLine ? (
          <Text {...small} color={SEMANTIC_COLORS.danger}>✖ Spot is at or through the line. Act now; no probability is shown.</Text>
        ) : (
          reach.value.rows.map((row) => (
            <Box key={row.horizonH}>
              {row.status === 'inside' ? (
                <ShownLine s={shown(row.result)} upperBound={row.isUpperBound} />
              ) : row.status === 'beyond' ? (
                <Text {...small} {...tabularNums}>
                  {fmtHorizon(row.horizonH)} · your line is past the model’s range
                  {row.edgePct !== null ? ` (deepest shown: ${Math.abs(row.edgePct)}%)` : ''}
                </Text>
              ) : null}
            </Box>
          ))
        )}
      </Block>
      <Text {...credit} gridColumn="1 / -1">
        † forecast of the Binance spot price touching a level, not of your venue’s oracle · gated per cell by the Q26 confidence map, not a guarantee
        {stamp ? ` · ${stamp}` : ''}
      </Text>
    </Box>
  )
}

export default ForecastPanel
