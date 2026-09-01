import React, { useCallback, useMemo } from 'react'
import { Box, SimpleGrid, Text } from '@chakra-ui/react'
import { lazyChart } from '@/components/ui/lazyChart'
import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { CHART_THEME, REFERENCE_STYLES, ASSET_COLORS } from '@/config/chartTheme'
import { Card } from '@/components/ui/Card'
import type { SimTick, SimConfig } from './engine/types'

// ─── Constants ────────────────────────────────────────────────────────────

const SYNC_ID = 'acquisition-sim'
const CHART_HEIGHT = 220
const CHART_MARGINS = { top: 8, right: 12, left: 8, bottom: 4 }

// Colors for specific signals
const COLORS = {
  pool: ASSET_COLORS[0],       // cyan
  rate: ASSET_COLORS[1],       // purple
  utilization: ASSET_COLORS[2], // green
  target: ASSET_COLORS[3],     // orange
  bumpUp: ASSET_COLORS[6],     // yellow
  bumpDown: ASSET_COLORS[0],   // cyan
  efficiency: ASSET_COLORS[4], // pink
  cdpImpact: ASSET_COLORS[7],  // red
  deposits: ASSET_COLORS[5],   // blue
} as const

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatCompact(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return n.toFixed(2)
}

function formatDay(day: number): string {
  return `${day.toFixed(0)}d`
}

/** Downsample ticks for chart rendering performance (max ~500 points) */
function downsample(ticks: SimTick[], maxPoints: number = 500): SimTick[] {
  if (ticks.length <= maxPoints) return ticks
  const step = Math.ceil(ticks.length / maxPoints)
  const result: SimTick[] = []
  for (let i = 0; i < ticks.length; i += step) {
    result.push(ticks[i])
  }
  // Always include last tick
  if (result[result.length - 1] !== ticks[ticks.length - 1]) {
    result.push(ticks[ticks.length - 1])
  }
  return result
}

// ─── Custom Tooltip ───────────────────────────────────────────────────────

interface ChartTooltipProps {
  active?: boolean
  payload?: Array<{ name: string; value: number; color: string }>
  label?: number
  formatter?: (value: number, name: string) => string
}

const ChartTooltip: React.FC<ChartTooltipProps> = ({
  active,
  payload,
  label,
  formatter,
}) => {
  if (!active || !payload?.length) return null
  return (
    <Box
      bg={SEMANTIC_COLORS.bgSecondary}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderStrong}
      borderRadius={0}
      px={SPACING.sm}
      py={SPACING.xs}
    >
      <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary} mb="2px">
        Day {label?.toFixed(1)}
      </Text>
      {payload.map((entry) => (
        <Text key={entry.name} fontSize={TYPOGRAPHY.xs} color={entry.color}>
          {entry.name}:{' '}
          {formatter ? formatter(entry.value, entry.name) : entry.value?.toFixed(2)}
        </Text>
      ))}
    </Box>
  )
}

// ─── Chart Wrapper ────────────────────────────────────────────────────────

interface ChartCardProps {
  title: string
  children: React.ReactNode
}

const ChartCard: React.FC<ChartCardProps> = ({ title, children }) => (
  <Card variant="subtle" p={SPACING.md}>
    <Text
      fontSize={TYPOGRAPHY.label}
      textTransform="uppercase"
      color={SEMANTIC_COLORS.textTertiary}
      mb={SPACING.sm}
    >
      {title}
    </Text>
    <Box h={`${CHART_HEIGHT}px`}>{children}</Box>
  </Card>
)

// ─── Chart Subtrees (lazy-loaded) ────────────────────────────────────────

type ChartMouseHandlers = {
  data: SimTick[]
  onMouseMove: (state: any) => void
  onMouseLeave: () => void
}

const PoolAccrualChart = lazyChart<ChartMouseHandlers & { maxMbrnEmission: number }>(
  ({ AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer }) =>
    function PoolAccrualChart({ data, onMouseMove, onMouseLeave, maxMbrnEmission }) {
      return (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={data}
            syncId={SYNC_ID}
            margin={CHART_MARGINS}
            onMouseMove={onMouseMove}
            onMouseLeave={onMouseLeave}
          >
            <CartesianGrid {...CHART_THEME.grid} />
            <XAxis
              dataKey="day"
              {...CHART_THEME.axis}
              tickFormatter={formatDay}
            />
            <YAxis
              {...CHART_THEME.axis}
              tickFormatter={formatCompact}
            />
            <Tooltip
              content={
                <ChartTooltip
                  formatter={(v) => formatCompact(v)}
                />
              }
            />
            <ReferenceLine
              y={maxMbrnEmission}
              {...REFERENCE_STYLES.liquidation}
              label={{
                ...REFERENCE_STYLES.liquidation.label,
                value: `Max: ${formatCompact(maxMbrnEmission)}`,
              }}
            />
            <defs>
              <linearGradient id="poolGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={COLORS.pool} stopOpacity={0.4} />
                <stop offset="95%" stopColor={COLORS.pool} stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey="accruedPool"
              name="Pool"
              stroke={COLORS.pool}
              fill="url(#poolGradient)"
              {...CHART_THEME.area}
            />
          </AreaChart>
        </ResponsiveContainer>
      )
    },
  CHART_HEIGHT,
)

const EmissionRateChart = lazyChart<ChartMouseHandlers & { baseAcquisitionRate: number; maxRate: number }>(
  ({ LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer }) =>
    function EmissionRateChart({ data, onMouseMove, onMouseLeave, baseAcquisitionRate, maxRate }) {
      return (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            syncId={SYNC_ID}
            margin={CHART_MARGINS}
            onMouseMove={onMouseMove}
            onMouseLeave={onMouseLeave}
          >
            <CartesianGrid {...CHART_THEME.grid} />
            <XAxis
              dataKey="day"
              {...CHART_THEME.axis}
              tickFormatter={formatDay}
            />
            <YAxis
              {...CHART_THEME.axis}
              tickFormatter={(v) => v.toFixed(0)}
            />
            <Tooltip
              content={
                <ChartTooltip
                  formatter={(v) => `${v.toFixed(2)} /sec`}
                />
              }
            />
            <ReferenceLine
              y={baseAcquisitionRate}
              stroke={COLORS.target}
              strokeDasharray="3 3"
              strokeWidth={1}
              label={{
                fill: COLORS.target,
                fontSize: 10,
                value: 'Base',
                position: 'right',
              }}
            />
            <ReferenceLine
              y={maxRate}
              {...REFERENCE_STYLES.liquidation}
              label={{
                ...REFERENCE_STYLES.liquidation.label,
                value: 'Max',
              }}
            />
            <Line
              type="stepAfter"
              dataKey="currentRate"
              name="Rate"
              stroke={COLORS.rate}
              {...CHART_THEME.line}
            />
          </LineChart>
        </ResponsiveContainer>
      )
    },
  CHART_HEIGHT,
)

const UtilizationChart = lazyChart<ChartMouseHandlers & { targetUtilization: number }>(
  ({ AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer }) =>
    function UtilizationChart({ data, onMouseMove, onMouseLeave, targetUtilization }) {
      return (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={data}
            syncId={SYNC_ID}
            margin={CHART_MARGINS}
            onMouseMove={onMouseMove}
            onMouseLeave={onMouseLeave}
          >
            <CartesianGrid {...CHART_THEME.grid} />
            <XAxis
              dataKey="day"
              {...CHART_THEME.axis}
              tickFormatter={formatDay}
            />
            <YAxis
              {...CHART_THEME.axis}
              domain={[0, 1]}
              tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
            />
            <Tooltip
              content={
                <ChartTooltip
                  formatter={(v) => `${(v * 100).toFixed(1)}%`}
                />
              }
            />
            <ReferenceLine
              y={targetUtilization}
              {...REFERENCE_STYLES.target}
              label={{
                ...REFERENCE_STYLES.target.label,
                value: `Target: ${(targetUtilization * 100).toFixed(0)}%`,
              }}
            />
            <defs>
              <linearGradient id="utilGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={COLORS.utilization} stopOpacity={0.3} />
                <stop offset="95%" stopColor={COLORS.utilization} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey="utilization"
              name="Utilization"
              stroke={COLORS.utilization}
              fill="url(#utilGradient)"
              {...CHART_THEME.area}
            />
          </AreaChart>
        </ResponsiveContainer>
      )
    },
  CHART_HEIGHT,
)

const BumpCdpImpactChart = lazyChart<ChartMouseHandlers>(
  ({ LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer }) =>
    function BumpCdpImpactChart({ data, onMouseMove, onMouseLeave }) {
      return (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            syncId={SYNC_ID}
            margin={CHART_MARGINS}
            onMouseMove={onMouseMove}
            onMouseLeave={onMouseLeave}
          >
            <CartesianGrid {...CHART_THEME.grid} />
            <XAxis
              dataKey="day"
              {...CHART_THEME.axis}
              tickFormatter={formatDay}
            />
            <YAxis
              yAxisId="bump"
              {...CHART_THEME.axis}
              tickFormatter={(v) => `${(v * 100).toFixed(1)}%`}
            />
            <YAxis
              yAxisId="cdp"
              orientation="right"
              {...CHART_THEME.axis}
              tickFormatter={(v) => `+${(v * 100).toFixed(1)}%`}
            />
            <Tooltip
              content={
                <ChartTooltip
                  formatter={(v, name) =>
                    name === 'CDP Impact'
                      ? `+${(v * 100).toFixed(2)}%`
                      : `${(v * 100).toFixed(3)}%`
                  }
                />
              }
            />
            <Line
              type="monotone"
              dataKey="bumpRate"
              name="Bump Rate"
              yAxisId="bump"
              stroke={COLORS.bumpUp}
              {...CHART_THEME.line}
            />
            <Line
              type="monotone"
              dataKey="cdpRateImpact"
              name="CDP Impact"
              yAxisId="cdp"
              stroke={COLORS.cdpImpact}
              strokeDasharray="5 5"
              {...CHART_THEME.line}
            />
          </LineChart>
        </ResponsiveContainer>
      )
    },
  CHART_HEIGHT,
)

const EfficiencyChart = lazyChart<ChartMouseHandlers>(
  ({ LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer }) =>
    function EfficiencyChart({ data, onMouseMove, onMouseLeave }) {
      return (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            syncId={SYNC_ID}
            margin={CHART_MARGINS}
            onMouseMove={onMouseMove}
            onMouseLeave={onMouseLeave}
          >
            <CartesianGrid {...CHART_THEME.grid} />
            <XAxis
              dataKey="day"
              {...CHART_THEME.axis}
              tickFormatter={formatDay}
            />
            <YAxis
              {...CHART_THEME.axis}
              tickFormatter={(v) => v.toFixed(1)}
            />
            <Tooltip
              content={
                <ChartTooltip
                  formatter={(v) => v.toFixed(3)}
                />
              }
            />
            <Line
              type="monotone"
              dataKey="efficiency"
              name="Efficiency"
              stroke={COLORS.efficiency}
              {...CHART_THEME.line}
            />
          </LineChart>
        </ResponsiveContainer>
      )
    },
  CHART_HEIGHT,
)

const DepositsChart = lazyChart<ChartMouseHandlers>(
  ({ AreaChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer }) =>
    function DepositsChart({ data, onMouseMove, onMouseLeave }) {
      return (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={data}
            syncId={SYNC_ID}
            margin={CHART_MARGINS}
            onMouseMove={onMouseMove}
            onMouseLeave={onMouseLeave}
          >
            <CartesianGrid {...CHART_THEME.grid} />
            <XAxis
              dataKey="day"
              {...CHART_THEME.axis}
              tickFormatter={formatDay}
            />
            <YAxis
              {...CHART_THEME.axis}
              tickFormatter={formatCompact}
            />
            <Tooltip
              content={
                <ChartTooltip
                  formatter={(v) => formatCompact(v)}
                />
              }
            />
            <defs>
              <linearGradient id="grossGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={COLORS.deposits} stopOpacity={0.3} />
                <stop offset="95%" stopColor={COLORS.deposits} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey="totalGrossDeposits"
              name="Gross Deposits"
              stroke={COLORS.deposits}
              fill="url(#grossGradient)"
              {...CHART_THEME.area}
            />
            <Line
              type="monotone"
              dataKey="totalNetDeposits"
              name="Net Deposits"
              stroke={COLORS.utilization}
              strokeDasharray="5 5"
              {...CHART_THEME.line}
            />
          </AreaChart>
        </ResponsiveContainer>
      )
    },
  CHART_HEIGHT,
)

// ─── Main Component ───────────────────────────────────────────────────────

interface SimChartsProps {
  ticks: SimTick[]
  config: SimConfig
  onCursorChange: (day: number | null) => void
}

export const SimCharts: React.FC<SimChartsProps> = ({
  ticks,
  config,
  onCursorChange,
}) => {
  const data = useMemo(() => downsample(ticks), [ticks])

  const handleMouseMove = useCallback(
    (state: any) => {
      if (state?.activeLabel != null) {
        onCursorChange(state.activeLabel)
      }
    },
    [onCursorChange]
  )

  const handleMouseLeave = useCallback(() => {
    onCursorChange(null)
  }, [onCursorChange])

  const maxRate = useMemo(
    () => config.maxMbrnEmission / (config.depositPeriodDays * 86400),
    [config]
  )

  if (data.length === 0) return null

  return (
    <SimpleGrid columns={{ base: 1, lg: 2 }} spacing={SPACING.md}>
      {/* ── 1. Pool Accrual ── */}
      <ChartCard title="Pool Accrual (uMBRN)">
        <PoolAccrualChart
          data={data}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          maxMbrnEmission={config.maxMbrnEmission}
        />
      </ChartCard>

      {/* ── 2. Emission Rate ── */}
      <ChartCard title="Emission Rate (uMBRN/sec)">
        <EmissionRateChart
          data={data}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          baseAcquisitionRate={config.baseAcquisitionRate}
          maxRate={maxRate}
        />
      </ChartCard>

      {/* ── 3. Utilization ── */}
      <ChartCard title="Utilization">
        <UtilizationChart
          data={data}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          targetUtilization={config.targetUtilization}
        />
      </ChartCard>

      {/* ── 4. Bump Rate + CDP Impact ── */}
      <ChartCard title="Bump Rate & CDP Impact">
        <BumpCdpImpactChart
          data={data}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        />
      </ChartCard>

      {/* ── 5. Efficiency ── */}
      <ChartCard title="Efficiency (Deposits / Pool)">
        <EfficiencyChart
          data={data}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        />
      </ChartCard>

      {/* ── 6. Deposits ── */}
      <ChartCard title="Cumulative Deposits (uCDT)">
        <DepositsChart
          data={data}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        />
      </ChartCard>
    </SimpleGrid>
  )
}
