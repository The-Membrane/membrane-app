// T + O: ONE DOUBLE-LINE CHART. The position on its venue and the same position on
// Membrane, one price path, liquidation / trim / armed-window / cure events marked, the
// one-sentence dollar verdict above and the honest-limits note right under it.
//
// Loaded behind dynamic() from ForecastLanding: it needs the measured price path, which
// only exists in the browser after a fetch, so it has nothing to server-render.

import React, { useMemo } from 'react'
import { Box, Button, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import EquityChart, { type ChartGhost, type ChartTick } from '@/components/Simulator/EquityChart'
import { usd } from '@/components/Simulator/format'
import { CURE_WINDOW_HOURS, CURE_WINDOW_SECONDS, MAX_THRESHOLD_TO_DELAY, type Comparison, type ProtocolPosition } from '@/lib/position-sim'
import { positionKey } from '@/lib/landing/replay'
import { depthRegistry, skewLines, skewNote, type UsdeExitLiquidity } from '@/lib/landing/sizeSkew'
import { armedWindows, eventMarks, verdictSentence } from '@/lib/landing/verdict'
import type { DelayStep, Slot } from '@/lib/landing/forecastLayer'
import { firstShown } from '@/lib/landing/forecastLayer'

import { credit, kicker, rule, small, tabularNums } from './styles'

export interface ReplayChartProps {
  comparison: Comparison | null
  startTs: number | null
  stepSeconds: number | null
  whose: 'this' | 'your'
  positions: ProtocolPosition[]
  selected: ProtocolPosition | null
  onSelect: (key: string) => void
  usdeExit: UsdeExitLiquidity | null
  /** Size lines lead (return state 'changed'). */
  sizeFirst: boolean
  delay: Slot<DelayStep[]> | null
  errors: string[]
  scenarioName: string
}

/**
 * The limits, out loud, next to the result (framework: "state sim limits next to the
 * result"). Generated from the run's own caveats where it has them.
 */
function limitsLine(cmp: Comparison, scenarioName: string): string {
  const parts = [
    `Replay, not a forecast: the measured ${scenarioName} oracle path applied to this position.`,
    'Liquidators assumed to fire the first minute over the line; gas, MEV and slippage on seized collateral not modelled.',
    'Membrane is pre-launch: its line here is modelled, not a protocol parameter.',
  ]
  if (cmp.unpricedSymbols.length) parts.push(`No price path for ${cmp.unpricedSymbols.join(', ')}: held flat.`)
  return parts.join(' ')
}

export const ReplayChart: React.FC<ReplayChartProps> = ({
  comparison,
  startTs,
  stepSeconds,
  whose,
  positions,
  selected,
  onSelect,
  usdeExit,
  sizeFirst,
  delay,
  errors,
  scenarioName,
}) => {
  const registry = useMemo(() => depthRegistry(usdeExit), [usdeExit])
  const skews = useMemo(() => (comparison ? skewLines(comparison, registry) : []), [comparison, registry])
  const ghosts = useMemo<ChartGhost[]>(
    () => skews.filter((s) => s.drawable).map((s) => ({ key: `${s.multiple}x`, label: `${s.multiple}× size, per 1×`, venue: s.venue, membrane: s.membrane })),
    [skews],
  )
  const cureMinutes = stepSeconds ? Math.round(CURE_WINDOW_SECONDS / stepSeconds) : 0
  const windows = useMemo(
    () => (comparison ? armedWindows(comparison, comparison.membrane.equitySeries.length, cureMinutes) : []),
    [comparison, cureMinutes],
  )
  const ticks = useMemo<ChartTick[]>(() => {
    if (!delay || delay.status !== 'ready') return []
    return delay.value.flatMap((s) => {
      const f = firstShown(s.reach)
      return f ? [{ minute: s.minute, text: f.shown.kind === 'none' ? '' : f.shown.text }] : []
    })
  }, [delay])

  const skewBlock = comparison && (
    <Box data-testid="landing-size-skew" display="grid" gap={SPACING.xs} borderTop={rule} pt={SPACING.sm}>
      <Text {...kicker}>Size · 10× and 100×</Text>
      {skews.map((s) => (
        <Text key={s.multiple} {...small} {...tabularNums}>
          {s.drawable && s.endCostPer1xUsd !== null
            ? `At ${s.multiple}× this size, exit would have cost ${usd(s.endCostPer1xUsd)} per 1× of position by the end (modelled bound). Dashed line.`
            : skewNote(s, registry)}
        </Text>
      ))}
    </Box>
  )

  return (
    <Box as="section" aria-labelledby="landing-replay-head" display="grid" gap={SPACING.md} minW={0}>
      {errors.map((e) => (
        <Text key={e} {...small} color={SEMANTIC_COLORS.danger} data-testid="landing-read-error">
          ✖ {e}
        </Text>
      ))}

      {positions.length > 1 && (
        <Box display="flex" flexWrap="wrap" gap={SPACING.sm} data-testid="landing-position-picker">
          {positions.map((p) => {
            const active = selected ? positionKey(p) === positionKey(selected) : false
            return (
              <Button
                key={positionKey(p)}
                onClick={() => onSelect(positionKey(p))}
                aria-pressed={active}
                variant="outline"
                size="sm"
                borderRadius={0}
                minH="44px"
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="11px"
                borderColor={active ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.borderSubtle}
                color={SEMANTIC_COLORS.textPrimary}
                transition={TRANSITIONS.colors}
                _focus={FOCUS_STYLES.ring}
              >
                {p.label} · {usd(p.totalDebtUsd)} debt
              </Button>
            )
          })}
        </Box>
      )}

      {!comparison ? (
        <Box h={{ base: '260px', md: '380px' }} borderTop={rule} display="grid" placeItems="center">
          <Text {...small}>Loading the measured price path…</Text>
        </Box>
      ) : (
        <>
          <Text
            id="landing-replay-head"
            data-testid="landing-verdict"
            fontFamily={TYPOGRAPHY.fontDisplay}
            fontSize={{ base: '22px', md: '30px' }}
            lineHeight={1.2}
            color={SEMANTIC_COLORS.textPrimary}
          >
            {verdictSentence(comparison, whose)}
          </Text>

          {sizeFirst && skewBlock}

          {startTs !== null && stepSeconds !== null && (
            <EquityChart
              comparison={comparison}
              startTs={startTs}
              stepSeconds={stepSeconds}
              title={`Position value · ${comparison.position.label} vs Membrane (simulator)`}
              marks={eventMarks(comparison)}
              bands={windows.map((w) => ({ start: w.start, end: w.end }))}
              ghosts={ghosts}
              ticks={ticks}
              bare
              caption={
                <Text {...small} {...tabularNums} data-testid="landing-chart-key">
                  <Text as="span" color={SEMANTIC_COLORS.danger}>✖ collateral sold</Text>
                  {' · '}
                  <Text as="span" color={SEMANTIC_COLORS.warning}>░ {CURE_WINDOW_HOURS}h window armed (within {Math.round(MAX_THRESHOLD_TO_DELAY * 100)}% of the line)</Text>
                  {' · '}
                  <Text as="span" color={SEMANTIC_COLORS.success}>● ▲ cured or recalled, nothing sold</Text>
                  {ghosts.length > 0 ? ' · dashed: size lines' : ''}
                  {ticks.length > 0 ? ' · ink ticks: model readings' : ''}
                </Text>
              }
            />
          )}

          <Text data-testid="landing-limits" {...small} borderTop={rule} pt={SPACING.sm}>
            † {limitsLine(comparison, scenarioName)}
          </Text>

          {!sizeFirst && skewBlock}

          <Text {...credit}>{comparison.scenarioLabel} · engine lib/position-sim · Membrane (simulator)</Text>
        </>
      )}
    </Box>
  )
}

export default ReplayChart
