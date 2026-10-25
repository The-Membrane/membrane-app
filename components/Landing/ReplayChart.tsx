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
import { armedWindows, eventMarks, verdictOf, type MeasuredSide } from '@/lib/landing/verdict'
import type { CensusRow } from '@/lib/landing/census'
import type { DelayStep, Slot } from '@/lib/landing/forecastLayer'
import { firstShown } from '@/lib/landing/forecastLayer'

import Details, { DetailLine } from './Details'
import { credit, rule, small, tabularNums } from './styles'

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
  /** Share actions, rendered inside the result's one Details (copy budget). */
  shareSlot?: React.ReactNode
  /** The census figures when the replayed position is the census position (the demo). */
  measured: MeasuredSide | null
  /** A live address's own census row: a different (Oct 10) position, shown as its own line. */
  addressCensus: CensusRow | null
}

/**
 * The limits, out loud, next to the result (framework: "state sim limits next to the
 * result"). Generated from the run's own caveats where it has them.
 */
function limitsLine(cmp: Comparison, scenarioName: string, measured: boolean): string {
  const parts = [
    `Replay, not a forecast: the measured ${scenarioName} oracle path applied to this position.`,
    measured
      ? 'Aave’s side is the census’s measured close, drawn as one mark at its first event; the census has no per-event split.'
      : 'Aave modelled at the median repay size, firing the first minute over the line; gas, MEV and slippage on seized collateral not modelled.',
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
  shareSlot,
  measured,
  addressCensus,
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
      if (s.alreadyPast) return [{ minute: s.minute, text: 'already past' }]
      const f = s.reach ? firstShown(s.reach) : null
      return f ? [{ minute: s.minute, text: f.shown.kind === 'none' ? '' : f.shown.text }] : []
    })
  }, [delay])

  // Size lines show only when there is a line to draw (copy budget). Assets without a
  // measured depth say so in Details, not on the page.
  const drawn = skews.filter((x) => x.drawable && x.endCostPer1xUsd !== null)
  // Three axis ticks: start, the crash (the venue's lowest-equity minute), end.
  const tickMinutes = useMemo(() => {
    if (!comparison) return undefined
    const eq = comparison.source.equitySeries
    let lo = 0
    for (let i = 1; i < eq.length; i++) if ((eq[i] ?? Infinity) < (eq[lo] ?? Infinity)) lo = i
    const end = eq.length - 1
    // A low at either end is not a crash between them: two ticks then.
    return lo > end * 0.1 && lo < end * 0.9 ? [0, lo, end] : [0, end]
  }, [comparison])

  const skewBlock = comparison && drawn.length > 0 && (
    <Box data-testid="landing-size-skew" display="grid" gap={SPACING.xs}>
      {drawn.map((x) => (
        <Text key={x.multiple} {...small} {...tabularNums} color={SEMANTIC_COLORS.textPrimary}>
          {x.multiple}×: −{usd(x.endCostPer1xUsd as number)} per 1× (modelled)
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
            {verdictOf(comparison, whose, measured).headline}
          </Text>
          <Text {...credit} textAlign="left" data-testid="landing-stamp">
            {measured ? 'Aave measured' : `${comparison.position.label.split(' · ')[0]} modelled`} · oracle 1-min
          </Text>

          {sizeFirst && skewBlock}

          {startTs !== null && stepSeconds !== null && (
            <EquityChart
              comparison={comparison}
              startTs={startTs}
              stepSeconds={stepSeconds}
              hideHeader
              tickMinutes={tickMinutes}
              marks={eventMarks(comparison)}
              bands={windows.map((w) => ({ start: w.start, end: w.end }))}
              ghosts={ghosts}
              ticks={ticks}
              bare
              caption={
                <Text {...small} {...tabularNums} data-testid="landing-chart-key">
                  <Text as="span" color={SEMANTIC_COLORS.danger}>✖ sold</Text>
                  {' '}
                  <Text as="span" color={SEMANTIC_COLORS.warning}>░ window</Text>
                  {' '}
                  <Text as="span" color={SEMANTIC_COLORS.success}>● cured</Text>
                </Text>
              }
            />
          )}

          {!sizeFirst && skewBlock}

          <Details testId="landing-result-details">
            {shareSlot}
            <DetailLine>{verdictOf(comparison, whose, measured).detail}</DetailLine>
            {addressCensus && (
              <DetailLine>
                This wallet is in the 10 Oct 2025 census: on its position that day, Aave closed {usd(addressCensus.aaveClosedUsd)} in{' '}
                {addressCensus.events} liquidation{addressCensus.events === 1 ? '' : 's'} (measured); Membrane would have closed{' '}
                {usd(addressCensus.membraneClosedUsd)} (simulator, census walk). The chart replays today’s position.
              </DetailLine>
            )}
            <DetailLine>
              ✖ collateral sold · ░ {CURE_WINDOW_HOURS}h window armed, within {Math.round(MAX_THRESHOLD_TO_DELAY * 100)}% of the line · ● ▲ cured or recalled,
              nothing sold{ghosts.length > 0 ? ' · dashed: size lines, per 1× of position' : ''}{ticks.length > 0 ? ' · ink ticks: model readings' : ''}.
            </DetailLine>
            <DetailLine>{limitsLine(comparison, scenarioName, !!measured)}</DetailLine>
            {skews.filter((x) => !x.drawable).map((x) => (
              <DetailLine key={x.multiple}>{skewNote(x, registry)}</DetailLine>
            ))}
            <DetailLine>
              {comparison.scenarioLabel} · engine lib/position-sim
            </DetailLine>
          </Details>
        </>
      )}
    </Box>
  )
}

export default ReplayChart
