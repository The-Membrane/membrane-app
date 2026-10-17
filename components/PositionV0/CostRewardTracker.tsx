import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Box, Button } from '@chakra-ui/react'

import { NEWS, NEWS_FONT } from '@/components/NewsEdition/tokens'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS } from '@/config/transitions'
import type { CostRewardView, MeasuredRatePoint, RateCoverage } from '@/lib/position/costReward'
import { fmtUtc } from '@/lib/position/format'
import { RATE_HISTORY } from '@/lib/position/rateHistory'
import type { ProtocolPosition } from '@/lib/position-sim/types'

import { Credit, Headline, Kicker, Mono, Rule, Section, Small, StaleTag } from './primitives'
import { TYPE, TYPE_PX } from './typeScale'
import { useCostReward } from './useCostReward'

/** Dollars/year, two significant figures. This is a rate snapshot, never realized profit. */
const annualDollars = (value: number): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumSignificantDigits: 2,
  })
    .format(value)
    .replace('-', '−')
const dateLabel = (date: string): string =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
const contributionName = (component: string) =>
  component === 'native' ? 'Native growth' : component === 'supply' ? 'Supply' : 'Borrow'
const formatCoverage = (coverage: RateCoverage): string =>
  coverage.totalValueUsd === null
    ? `${coverage.pricedLegs} of ${coverage.legs} assets · total value unavailable`
    : `${annualDollars(coverage.pricedValueUsd)} / ${annualDollars(coverage.totalValueUsd)}`

const WINDOW_DAYS = { '7d': 7, '30d': 30, Available: 90 } as const
type HistoryWindow = keyof typeof WINDOW_DAYS
const X0 = 64,
  Y0 = 18,
  Y1 = 188

function useHistoryWindow(history: MeasuredRatePoint[], window: HistoryWindow) {
  return useMemo(() => {
    if (history.length === 0) return []
    const end = Date.parse(`${history[history.length - 1].date}T00:00:00Z`)
    const cutoff = end - (WINDOW_DAYS[window] - 1) * 86_400_000
    return history.filter((point) => Date.parse(`${point.date}T00:00:00Z`) >= cutoff)
  }, [history, window])
}

interface RateChartProps {
  points: MeasuredRatePoint[]
}
/** Separate path fragments retain real gaps, including parameter-change seams. */
export const MeasuredRateChart: React.FC<RateChartProps> = ({ points }) => {
  const id = useId().replace(/:/g, '')
  const [selected, setSelected] = useState<number | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(350)
  useEffect(() => {
    if (!container.current) return
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width
      if (next && next > X0 + 40) setWidth(next)
    })
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  const values = points
    .flatMap((point) => [point.costUsdPerYear, point.incomeUsdPerYear])
    .filter((x): x is number => x !== null)
  if (values.length === 0)
    return (
      <Box ref={container}>
        <Mono py={SPACING.base}>Rate history unavailable for these assets.</Mono>
      </Box>
    )
  const X1 = width - 12
  const low = Math.min(0, ...values),
    high = Math.max(0, ...values)
  const span = high - low || Math.max(Math.abs(high), 1)
  const y = (value: number) => Y1 - ((value - low) / span) * (Y1 - Y0)
  const x = (index: number) =>
    X0 + (points.length > 1 ? index / (points.length - 1) : 0.5) * (X1 - X0)
  const active = selected !== null && selected < points.length ? points[selected] : null
  const paths = (side: 'costUsdPerYear' | 'incomeUsdPerYear') => {
    let path = ''
    return points.map((point, index) => {
      const value = point[side]
      if (value === null) {
        path = ''
        return null
      }
      const d = `${path ? 'L' : 'M'}${x(index)} ${y(value)}`
      path = d
      const previous = index > 0 ? points[index - 1][side] : null
      return previous !== null && index > 0 ? (
        <path key={point.date} d={`M${x(index - 1)} ${y(previous)} ${d}`} />
      ) : (
        <circle
          key={point.date}
          cx={x(index)}
          cy={y(value)}
          r={2.5}
          fill={NEWS.ink}
          stroke="none"
        />
      )
    })
  }
  const last = (side: 'costUsdPerYear' | 'incomeUsdPerYear') => {
    for (let i = points.length - 1; i >= 0; i--) if (points[i][side] !== null) return i
    return null
  }
  const costLast = last('costUsdPerYear'),
    incomeLast = last('incomeUsdPerYear')
  return (
    <Box minW={0} ref={container}>
      <Small>$ / year at this read&apos;s size and prices</Small>
      <Box mt={SPACING.sm} position="relative" minW={0}>
        <svg
          viewBox={`0 0 ${width} 230`}
          width="100%"
          role="img"
          aria-labelledby={`${id}-title ${id}-description`}
          style={{ display: 'block', fontFamily: NEWS_FONT.mono, overflow: 'visible' }}
        >
          <title id={`${id}-title`}>Measured cost and income at the selected position size</title>
          <desc id={`${id}-description`}>
            Annualized snapshot dollars per year, not cumulative earnings. Cost is solid; income is
            dashed. Gaps are missing observations. Full observations are in Sources and data.
          </desc>
          {[low, low + span / 2, low + span].map((value, i) => (
            <g key={i}>
              <line
                x1={X0}
                x2={X1}
                y1={y(value)}
                y2={y(value)}
                stroke={NEWS.rule}
                strokeDasharray="2 4"
              />
              <text
                x={X0 - 8}
                y={y(value) + 4}
                textAnchor="end"
                fill={NEWS.ink2}
                fontSize={TYPE_PX.label}
              >
                {annualDollars(value)}
              </text>
            </g>
          ))}
          <g stroke={NEWS.ink} strokeWidth={1.6} fill="none" vectorEffect="non-scaling-stroke">
            {paths('costUsdPerYear')}
          </g>
          <g
            stroke={NEWS.ink}
            strokeWidth={1.6}
            fill="none"
            strokeDasharray="6 4"
            vectorEffect="non-scaling-stroke"
          >
            {paths('incomeUsdPerYear')}
          </g>
          {costLast !== null && (
            <text
              x={Math.min(X1, x(costLast))}
              y={Math.max(12, y(points[costLast].costUsdPerYear as number) - 9)}
              textAnchor="end"
              fill={NEWS.ink}
              fontSize={TYPE_PX.body}
            >
              Cost —
            </text>
          )}
          {incomeLast !== null && (
            <text
              x={Math.min(X1, x(incomeLast))}
              y={Math.min(206, y(points[incomeLast].incomeUsdPerYear as number) + 17)}
              textAnchor="end"
              fill={NEWS.ink}
              fontSize={TYPE_PX.body}
            >
              Income – –
            </text>
          )}
          {active && (
            <line
              x1={x(selected as number)}
              x2={x(selected as number)}
              y1={Y0}
              y2={Y1}
              stroke={NEWS.ink2}
              strokeDasharray="2 4"
            />
          )}
          <text x={X0} y={224} fill={NEWS.ink2} fontSize={TYPE_PX.label}>
            {dateLabel(points[0].date)}
          </text>
          <text x={X1} y={224} textAnchor="end" fill={NEWS.ink2} fontSize={TYPE_PX.label}>
            {dateLabel(points[points.length - 1].date)}
          </text>
        </svg>
      </Box>
      <Box as="label" display="block" mt={SPACING.sm}>
        <Small as="span">Inspect a date</Small>
        <Box
          as="input"
          type="range"
          aria-label="Inspect measured rate date"
          min={0}
          max={Math.max(0, points.length - 1)}
          value={selected ?? points.length - 1}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
            setSelected(Number(event.target.value))
          }
          w="100%"
          minH="44px"
          accentColor={NEWS.ink}
        />
      </Box>
      {active && (
        <Small role="status" aria-live="polite">
          {dateLabel(active.date)} · Cost{' '}
          {active.costUsdPerYear === null
            ? 'unavailable'
            : `${annualDollars(active.costUsdPerYear)}/year`}{' '}
          · Income{' '}
          {active.incomeUsdPerYear === null
            ? 'unavailable'
            : `${annualDollars(active.incomeUsdPerYear)}/year`}
        </Small>
      )}
    </Box>
  )
}

export const CostRewardContent: React.FC<{ model: CostRewardView; position: ProtocolPosition }> = ({
  model,
  position,
}) => {
  const hatchId = useId().replace(/:/g, '')
  const [window, setWindow] = useState<HistoryWindow>('30d')
  const points = useHistoryWindow(model.history, window)
  const stale = model.current.state === 'stale'
  const anyHistory = points.some(
    (point) => point.costUsdPerYear !== null || point.incomeUsdPerYear !== null,
  )
  const activeDebt = position.debt.filter((leg) => leg.amount > 0)
  const activeCollateral = position.collateral.filter((leg) => leg.amount > 0)
  const sameToken =
    activeDebt.length > 0 &&
    activeCollateral.length > 0 &&
    new Set([...activeDebt, ...activeCollateral].map((leg) => leg.address.toLowerCase())).size === 1
  const ethRatio =
    position.protocol === 'compound-v3' &&
    position.marketId?.toLowerCase() === '0xa17581a9e3356d9a858b789d68b4d866e593ae94' &&
    activeDebt.length > 0 &&
    activeCollateral.length > 0 &&
    activeDebt.every(
      (leg) => leg.address.toLowerCase() === '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    ) &&
    activeCollateral.every(
      (leg) => leg.address.toLowerCase() === '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0',
    )
  const figure = (label: string, value: number | null, empty: string) => (
    <Box minW={0}>
      <Small>{label}</Small>
      <Mono fontWeight={700}>{value === null ? empty : `${annualDollars(value)}/year`}</Mono>
    </Box>
  )
  return (
    <Section
      id="cost-reward"
      data-testid="cost-reward-tracker"
      mt={SPACING.lg}
      borderTop={`1px solid ${NEWS.ruleStrong}`}
    >
      <Kicker>Cost and income</Kicker>
      <Headline>What rates cost and pay</Headline>
      <Small>Measured rates · this read&apos;s size and prices</Small>
      {model.current.state === 'loading' && <Small>Checking the rate observation time.</Small>}
      {stale && (
        <Small>
          <StaleTag /> · current inputs are too old. Current figures withheld.
        </Small>
      )}
      {model.current.state === 'unavailable' && (
        <Small>Observation time unavailable. Current figures withheld.</Small>
      )}
      {model.contributions.some((leg) => leg.notionalUsd === null) && (
        <Small>Dollar conversion unavailable for some assets.</Small>
      )}
      <Box
        display="grid"
        gridTemplateColumns={{ base: '1fr 1fr', md: 'repeat(3, 1fr)' }}
        gap={SPACING.base}
        py={SPACING.sm}
        minW={0}
        position="relative"
        data-testid="current-rate-figures"
      >
        {stale && (
          <svg
            aria-hidden="true"
            width="100%"
            height="100%"
            style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
          >
            <defs>
              <pattern id={hatchId} width={10} height={10} patternUnits="userSpaceOnUse">
                <path d="M0 10L10 0" stroke={NEWS.ink} strokeOpacity={0.1} />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill={`url(#${hatchId})`} />
          </svg>
        )}
        {figure(
          'Interest cost',
          model.current.costUsdPerYear,
          model.noDebt ? 'No debt' : 'Unavailable',
        )}
        {figure(
          'Income',
          model.current.incomeUsdPerYear,
          model.incomeCoverage.legs === 0 ? 'No income asset assigned' : 'Unavailable',
        )}
        {model.current.spreadUsdPerYear !== null &&
          figure('Income minus interest', model.current.spreadUsdPerYear, 'Unavailable')}
      </Box>
      {anyHistory && (
        <Box
          display="flex"
          flexWrap="wrap"
          gap={SPACING.sm}
          role="group"
          aria-label="Rate history window"
        >
          {(Object.keys(WINDOW_DAYS) as HistoryWindow[]).map((choice) => (
            <Button
              key={choice}
              type="button"
              variant="unstyled"
              minH="44px"
              minW="58px"
              px={SPACING.sm}
              fontFamily={NEWS_FONT.mono}
              fontSize={TYPE.label}
              borderRadius={0}
              borderBottom={`1px solid ${window === choice ? NEWS.ink : NEWS.rule}`}
              aria-pressed={window === choice}
              onClick={() => setWindow(choice)}
              transition={TRANSITIONS.colors}
              _focusVisible={{ outline: `1px solid ${NEWS.ink}`, outlineOffset: '2px' }}
            >
              {choice}
            </Button>
          ))}
        </Box>
      )}
      <MeasuredRateChart key={window} points={points} />
      <Small fontStyle="italic">Annualized snapshots, not paid or earned totals.</Small>
      {sameToken && <Small>A common price move cancels. Interest can still move the line.</Small>}
      {ethRatio && <Small>The wstETH/WETH ratio moves this line. ETH/USD does not.</Small>}
      <Credit>
        {points.length > 0 && anyHistory
          ? `Observed ${points[0].date}–${points[points.length - 1].date} · Aave reserve history`
          : 'No matched historical rate source'}
      </Credit>
      <Box as="details" minW={0}>
        <Box
          as="summary"
          minH="44px"
          cursor="pointer"
          fontFamily={NEWS_FONT.mono}
          fontSize={TYPE.body}
          borderTop={`1px solid ${NEWS.rule}`}
          py={SPACING.md}
          _focusVisible={{ outline: `1px solid ${NEWS.ink}`, outlineOffset: '2px' }}
        >
          Sources and data
        </Box>
        <Box display="grid" gap={SPACING.sm} pt={SPACING.sm} minW={0}>
          <Small>
            Debt rate coverage: {formatCoverage(model.debtCoverage)}. Income rate coverage:{' '}
            {formatCoverage(model.incomeCoverage)}.
          </Small>
          <Small>
            Observed:{' '}
            {model.current.observedAtMs === null
              ? 'unavailable'
              : fmtUtc(model.current.observedAtMs)}
            . Fetched: {fmtUtc(model.current.fetchedAtMs)}.
          </Small>
          <Small>
            Native growth, assigned venue income and borrower interest are separate components.
            External deployments are not assigned by wallet co-ownership.
          </Small>
          {model.contributions.map((leg) => (
            <Box key={leg.id} borderTop={`1px solid ${NEWS.rule}`} pt={SPACING.sm} minW={0}>
              <Mono>
                {leg.symbol} · {contributionName(leg.component)} · {leg.assignment}
              </Mono>
              <Small>{leg.source}</Small>
              <Small>
                {leg.currentApr === null
                  ? leg.missingReason
                  : leg.component === 'borrow' && leg.currentApr === 0
                    ? 'No observed protocol interest at this read'
                    : `Observed rate ${(leg.currentApr * 100).toLocaleString('en-US', { maximumSignificantDigits: 3 })}%/year`}{' '}
                ·{' '}
                {leg.history
                  ? `${leg.history.points.length} daily slots · ${leg.history.rateConvention}`
                  : 'History unavailable for this component'}
              </Small>
              {leg.history && (
                <Small overflowWrap="anywhere">
                  Sources: {leg.history.sourcePaths.join(', ')}. {leg.history.limitations.join(' ')}
                </Small>
              )}
            </Box>
          ))}
          <Rule />
          <Small>
            Incentives ‡ excluded. Campaign eligibility and payouts are not measured here. Membrane
            shares are not priced without verified charges.
          </Small>
          <Small>
            Price changes, exit costs and liquidation losses are outside these rate snapshots. No
            cumulative return or break-even date is inferred.
          </Small>
          <Small>Forecast unavailable. Forward rate paths and time-to-line are withheld.</Small>
          <Small overflowWrap="anywhere">
            Generated history source: membrane-datasets {RATE_HISTORY.source.commit}. Source file
            SHA-256:{' '}
            {Object.entries(RATE_HISTORY.source.sha256)
              .map(([path, hash]) => `${path}: ${hash}`)
              .join(' · ')}
          </Small>
          {points.length > 0 && (
            <Box
              as="table"
              w="100%"
              fontFamily={NEWS_FONT.mono}
              fontSize={TYPE.label}
              sx={{
                borderCollapse: 'collapse',
                tableLayout: 'fixed',
                '& th, & td': {
                  textAlign: 'left',
                  verticalAlign: 'top',
                  overflowWrap: 'anywhere',
                  padding: '8px 4px',
                  borderBottom: `1px solid ${NEWS.rule}`,
                },
              }}
            >
              <caption style={{ textAlign: 'left' }}>
                Measured annualized snapshots · $/year
              </caption>
              <thead>
                <tr>
                  <th scope="col">Observed date</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Income</th>
                </tr>
              </thead>
              <tbody>
                {points.map((point) => (
                  <tr key={point.date}>
                    <td>{point.date}</td>
                    <td>
                      {point.costUsdPerYear === null
                        ? 'Unavailable'
                        : annualDollars(point.costUsdPerYear)}
                      {point.costObservedAtMs !== null && (
                        <span style={{ display: 'block' }}>{fmtUtc(point.costObservedAtMs)}</span>
                      )}
                    </td>
                    <td>
                      {point.incomeUsdPerYear === null
                        ? 'Unavailable'
                        : annualDollars(point.incomeUsdPerYear)}
                      {point.incomeObservedAtMs !== null && (
                        <span style={{ display: 'block' }}>{fmtUtc(point.incomeObservedAtMs)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Box>
          )}
          {points.some((point) => point.missing.length > 0) && (
            <Small>
              Gaps: missing rates, unmatched components or changed curve parameters. No rate is
              filled across a gap.
            </Small>
          )}
        </Box>
      </Box>
    </Section>
  )
}

export const CostRewardTracker: React.FC<{ scope: string; position: ProtocolPosition }> = ({
  scope,
  position,
}) => {
  const model = useCostReward(scope, position)
  return <CostRewardContent model={model} position={position} />
}
