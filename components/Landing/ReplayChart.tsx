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
import { carryCost, CURE_WINDOW_HOURS, CURE_WINDOW_SECONDS, MAX_THRESHOLD_TO_DELAY, type VenueDetection, type Comparison, type ProtocolPosition } from '@/lib/position-sim'
import { positionKey } from '@/lib/landing/replay'
import { depthRegistry, skewLines, skewNote, type UsdeExitLiquidity } from '@/lib/landing/sizeSkew'
import { armedWindows, eventMarks, outcomeBeat, troubleLine, verdictOf, verdictShort, type MeasuredSide } from '@/lib/landing/verdict'
import { fmtLocalClock, useLocalZone } from '@/components/Simulator/localClock'
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
  carry?: boolean
  detection?: VenueDetection | null
  /** The census figures when the replayed position is the census position (the demo). */
  measured: MeasuredSide | null
  /** The slim forecast strip, rendered right under the chart (not its own section). */
  belowChart?: React.ReactNode
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

/** /carry, T: what the venue bills the carry, from the rate read on-chain. */
function carryTroubleTail(p: ProtocolPosition | null, d: VenueDetection | null): string {
  const c = carryCost(p, d)
  return c.annualCostUsd > 0 ? ` Its borrow bills ${usd(c.annualCostUsd)} a year, yield or not.` : ''
}

/** /carry, O: the recall (simulator) and the slice that would carry no interest. */
function carryOutcomeTail(cmp: Comparison, p: ProtocolPosition | null, d: VenueDetection | null): string {
  const recalled = cmp.membrane.events.reduce((a, e) => a + Math.max(0, e.recalledUsd), 0)
  const c = carryCost(p, d)
  const parts: string[] = []
  if (recalled >= 0.5) parts.push(` Venues would have returned ${usd(recalled)} first (simulator).`)
  if (c.coveredDebtUsd >= 0.5) parts.push(` The ${usd(c.coveredDebtUsd)} deployed slice would accrue no interest.`)
  return parts.join('')
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
  carry = false,
  detection = null,
  measured,
  addressCensus,
  belowChart = null,
}) => {
  const zone = useLocalZone()
  const clock = (ts: number) => fmtLocalClock(ts, zone)
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
        <>
          <Box as="section" data-story="T" minH="36px" />
          <Box h={{ base: '260px', md: '380px' }} borderTop={rule} display="grid" placeItems="center">
            <Text {...small}>Loading the measured price path…</Text>
          </Box>
          <Box as="section" data-story="O" minH="36px" />
        </>
      ) : (
        <>
          {/* T — TROUBLE: what the venue did, in the visitor's numbers, above the chart. */}
          <Text
            as="section"
            id="landing-replay-head"
            data-story="T"
            data-testid="landing-trouble"
            fontFamily={TYPOGRAPHY.fontDisplay}
            fontSize={{ base: '22px', md: '30px' }}
            lineHeight={1.2}
            color={SEMANTIC_COLORS.textPrimary}
          >
            {troubleLine(comparison, whose, measured, clock)}
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
              caption={null}
            />
          )}

          {belowChart}

          {/* O — OUTCOME: time to act, what Membrane would have done, nothing asked of
              the user. The debt-gap verdict follows, second. */}
          <Box as="section" data-story="O" data-testid="landing-outcome" display="grid" gap={SPACING.xs}>
            <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={{ base: '19px', md: '24px' }} lineHeight={1.25} color={SEMANTIC_COLORS.textPrimary}>
              {stepSeconds !== null
                ? outcomeBeat(comparison, measured, windows, clock, {
                    cureHours: CURE_WINDOW_HOURS,
                    bandPct: Math.round(MAX_THRESHOLD_TO_DELAY * 100),
                    stepSeconds,
                  })
                : null}
            </Text>
          </Box>

          {!sizeFirst && skewBlock}

          <Details testId="landing-result-details">
            {shareSlot}
            <DetailLine>
              <Text as="span" data-testid="landing-stamp">
                {measured ? 'Aave measured' : `${comparison.position.label.split(' · ')[0]} modelled`} · oracle 1-min
              </Text>
            </DetailLine>
            <DetailLine>
              <Text as="span" data-testid="landing-verdict">{verdictShort(comparison, measured)}</Text>
            </DetailLine>
            {carry && (carryTroubleTail(selected, detection) || carryOutcomeTail(comparison, selected, detection)) && (
              <DetailLine>{`${carryTroubleTail(selected, detection)}${carryOutcomeTail(comparison, selected, detection)}`.trim()}</DetailLine>
            )}
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
