import React, { useMemo } from 'react'
import { Box, VStack, Text, Grid, Tooltip, HStack, Skeleton } from '@chakra-ui/react'
import { InfoOutlineIcon } from '@chakra-ui/icons'
import { lazyChart } from '@/components/ui/lazyChart'
import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { CHART_THEME, ASSET_COLORS, createCustomLegend, REFERENCE_STYLES } from '@/config/chartTheme'
import { Card } from '@/components/ui/Card'
import {
  useRevenueHistory,
  useInterestRateHistory,
  useLiquidationFunnelData,
} from '@/hooks/useMembraneDashboard'

/* ── Tooltip helper ── */
const ChartInfo: React.FC<{ tip: string }> = ({ tip }) => (
  <Tooltip
    label={tip}
    placement="top"
    hasArrow
    bg={SEMANTIC_COLORS.bgSecondary}
    border={`1px solid ${SEMANTIC_COLORS.borderMedium}`}
    color={SEMANTIC_COLORS.textPrimary}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="xs"
    px={3}
    py={2}
    maxW="280px"
  >
    <Box as="span" display="inline-flex" cursor="help">
      <InfoOutlineIcon boxSize="12px" color={SEMANTIC_COLORS.textTertiary} _hover={{ color: SEMANTIC_COLORS.textSecondary }} />
    </Box>
  </Tooltip>
)

/* ── Stat card ── */
const StatCard: React.FC<{
  label: string
  value: string
  valueColor?: string
  isLoading?: boolean
}> = ({ label, value, valueColor = SEMANTIC_COLORS.info, isLoading = false }) => (
  <Card p={SPACING.base}>
    <Text
      fontSize={TYPOGRAPHY.label}
      textTransform="uppercase"
      color={SEMANTIC_COLORS.textSecondary}
      fontFamily={TYPOGRAPHY.fontMono}
      letterSpacing="0.5px"
      mb={SPACING.sm}
    >
      {label}
    </Text>
    {isLoading ? (
      <Skeleton h="32px" />
    ) : (
      <Text
        fontSize="2xl"
        fontWeight={TYPOGRAPHY.bold}
        color={valueColor}
        fontFamily={TYPOGRAPHY.fontMono}
      >
        {value}
      </Text>
    )}
  </Card>
)

/* ── Custom tooltips ── */
const RevenueTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <Box bg={SEMANTIC_COLORS.bgSecondary} border="1px solid" borderColor={SEMANTIC_COLORS.borderMedium} borderRadius={0} px={3} py={2}>
      <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary} mb={1}>{label}</Text>
      {payload.map((p: any) => (
        <Text key={p.dataKey} fontSize={TYPOGRAPHY.small} color={p.color}>
          {p.name}: {Number(p.value).toLocaleString()} CDT
        </Text>
      ))}
    </Box>
  )
}

const RateTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <Box bg={SEMANTIC_COLORS.bgSecondary} border="1px solid" borderColor={SEMANTIC_COLORS.borderMedium} borderRadius={0} px={3} py={2}>
      <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary} mb={1}>{label}</Text>
      {payload.map((p: any) => (
        <Text key={p.dataKey} fontSize={TYPOGRAPHY.small} color={p.color}>
          {p.name}: {p.value}%
        </Text>
      ))}
    </Box>
  )
}

const LiquidationTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  const activated = payload.reduce((sum: number, p: any) => sum + (p.value || 0), 0)
  return (
    <Box bg={SEMANTIC_COLORS.bgSecondary} border="1px solid" borderColor={SEMANTIC_COLORS.borderMedium} borderRadius={0} px={3} py={2}>
      <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textSecondary} mb={1}>{label}</Text>
      <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary} mb={1}>
        Total activated: {activated}
      </Text>
      {payload.map((p: any) => {
        const pct = activated > 0 ? ((p.value / activated) * 100).toFixed(0) : 0
        return (
          <Text key={p.dataKey} fontSize={TYPOGRAPHY.small} color={p.color}>
            {p.name}: {p.value} ({pct}%)
          </Text>
        )
      })}
    </Box>
  )
}

/* ── Chart data types (derived from hook return types) ── */
type RevenueDatum = NonNullable<ReturnType<typeof useRevenueHistory>['data']>[number]
type RateDatum = NonNullable<ReturnType<typeof useInterestRateHistory>['data']>[number]
type LiqDatum = NonNullable<ReturnType<typeof useLiquidationFunnelData>['data']>[number]

/* ── Lazy-loaded chart subtrees ── */
const RevenueLineChart = lazyChart<{ data: RevenueDatum[] }>(
  ({ LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip: RechartsTooltip, ResponsiveContainer, Legend }) =>
    function RevenueLineChart({ data }) {
      return (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid {...CHART_THEME.grid} />
            <XAxis
              dataKey="date"
              {...CHART_THEME.xAxis}
              interval="preserveStartEnd"
            />
            <YAxis
              {...CHART_THEME.yAxis}
              tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`}
            />
            <RechartsTooltip content={<RevenueTooltip />} />
            <Legend content={createCustomLegend()} />
            <Line
              type="monotone"
              dataKey="grossRevenue"
              name="Gross Revenue"
              stroke={ASSET_COLORS[0]}
              {...CHART_THEME.line}
            />
            <Line
              type="monotone"
              dataKey="netRevenue"
              name="Net Revenue"
              stroke={ASSET_COLORS[2]}
              {...CHART_THEME.line}
            />
          </LineChart>
        </ResponsiveContainer>
      )
    },
  '100%',
)

const RateLineChart = lazyChart<{ data: RateDatum[]; avgBaseRate: number }>(
  ({ LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip: RechartsTooltip, ResponsiveContainer, ReferenceLine, Legend }) =>
    function RateLineChart({ data, avgBaseRate }) {
      return (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid {...CHART_THEME.grid} />
            <XAxis
              dataKey="date"
              {...CHART_THEME.xAxis}
              interval="preserveStartEnd"
            />
            <YAxis
              {...CHART_THEME.yAxis}
              tickFormatter={(v: number) => `${v}%`}
            />
            <RechartsTooltip content={<RateTooltip />} />
            <Legend content={createCustomLegend()} />
            <ReferenceLine
              y={avgBaseRate}
              {...REFERENCE_STYLES.target}
              label={{ value: 'Base Rate', ...REFERENCE_STYLES.target.label }}
            />
            <Line
              type="monotone"
              dataKey="avgRate"
              name="Avg Rate"
              stroke={ASSET_COLORS[0]}
              {...CHART_THEME.line}
            />
            <Line
              type="monotone"
              dataKey="spikeHeight"
              name="Spike Height"
              stroke={ASSET_COLORS[7]}
              strokeDasharray="5 5"
              {...CHART_THEME.line}
            />
          </LineChart>
        </ResponsiveContainer>
      )
    },
  '100%',
)

const LiquidationBarChart = lazyChart<{ data: LiqDatum[] }>(
  ({ BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip: RechartsTooltip, ResponsiveContainer, Legend }) =>
    function LiquidationBarChart({ data }) {
      return (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid {...CHART_THEME.grid} />
            <XAxis
              dataKey="date"
              {...CHART_THEME.xAxis}
            />
            <YAxis
              {...CHART_THEME.yAxis}
            />
            <RechartsTooltip content={<LiquidationTooltip />} />
            <Legend content={createCustomLegend()} />
            <Bar
              dataKey="savedByDelay"
              name="Saved by Delay"
              stackId="liquidations"
              fill={SEMANTIC_COLORS.success}
              radius={[0, 0, 0, 0]}
            />
            <Bar
              dataKey="windowExpired"
              name="Window Expired"
              stackId="liquidations"
              fill={SEMANTIC_COLORS.warning}
              radius={[0, 0, 0, 0]}
            />
            <Bar
              dataKey="windowBroken"
              name="Window Broken"
              stackId="liquidations"
              fill={SEMANTIC_COLORS.danger}
              radius={[0, 0, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      )
    },
  '100%',
)

/* ── Section header ── */
const SectionHeader: React.FC<{ title: string; info: string }> = ({ title, info }) => (
  <HStack spacing={SPACING.sm}>
    <Text
      fontSize={TYPOGRAPHY.small}
      fontWeight={TYPOGRAPHY.bold}
      color={SEMANTIC_COLORS.textSecondary}
      fontFamily={TYPOGRAPHY.fontMono}
      letterSpacing="1px"
      textTransform="uppercase"
    >
      {title}
    </Text>
    <ChartInfo tip={info} />
  </HStack>
)

/* ── Main dashboard ── */
const MembraneDashboard: React.FC = () => {
  const { data: revenueData, isLoading: revenueLoading } = useRevenueHistory()
  const { data: rateData, isLoading: rateLoading } = useInterestRateHistory()
  const { data: liqData, isLoading: liqLoading } = useLiquidationFunnelData()

  // Summary stats
  const stats = useMemo(() => {
    const latestRevenue = revenueData?.[revenueData.length - 1]
    const grossTotal = latestRevenue?.grossRevenue ?? 0
    const netTotal = latestRevenue?.netRevenue ?? 0

    const avgRate = rateData
      ? rateData.reduce((sum, d) => sum + d.avgRate, 0) / rateData.length
      : 0

    const totalActivated = liqData?.reduce((sum, d) => sum + d.activated, 0) ?? 0
    const totalSaved = liqData?.reduce((sum, d) => sum + d.savedByDelay, 0) ?? 0
    const saveRate = totalActivated > 0 ? (totalSaved / totalActivated) * 100 : 0

    return {
      grossRevenue: grossTotal.toLocaleString(),
      netRevenue: netTotal.toLocaleString(),
      avgRate: avgRate.toFixed(2) + '%',
      saveRate: saveRate.toFixed(1) + '%',
    }
  }, [revenueData, rateData, liqData])

  // Average base rate for reference line
  const avgBaseRate = useMemo(() => {
    if (!rateData?.length) return 3
    return rateData.reduce((sum, d) => sum + d.baseRate, 0) / rateData.length
  }, [rateData])

  const isLoading = revenueLoading || rateLoading || liqLoading

  return (
    <Box position="relative" w="100%" minH="100vh" bg="#0A0A0A">
      {/* Hexagonal Background Grid — app chrome only, kept barely-there in bone hairline */}
      <Box position="fixed" inset={0} opacity={0.4} zIndex={0} pointerEvents="none">
        <Box as="svg" w="100%" h="100%">
          <defs>
            <pattern id="hexagonPatternMembrane" x="0" y="0" width="103.92" height="60" patternUnits="userSpaceOnUse">
              <polygon
                points="34.64,10 51.96,20 51.96,40 34.64,50 17.32,40 17.32,20"
                fill="none"
                stroke="rgba(236, 230, 216, 0.06)"
                strokeWidth="1"
              />
              <polygon
                points="86.6,40 103.92,50 103.92,70 86.6,80 69.28,70 69.28,50"
                fill="none"
                stroke="rgba(236, 230, 216, 0.06)"
                strokeWidth="1"
              />
              <polygon
                points="86.6,-20 103.92,-10 103.92,10 86.6,20 69.28,10 69.28,-10"
                fill="none"
                stroke="rgba(236, 230, 216, 0.06)"
                strokeWidth="1"
              />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#hexagonPatternMembrane)" />
        </Box>
      </Box>

      <Box w="100%" maxW="1400px" mx="auto" p={{ base: 4, md: 8 }} pt={{ base: 24, md: 28 }} position="relative" zIndex={1}>
        <VStack spacing={SPACING.xl} align="stretch">
          {/* Page Header */}
          <VStack spacing={1}>
            <Text
              as="h1"
              fontSize={TYPOGRAPHY.h1}
              fontWeight={TYPOGRAPHY.bold}
              color={SEMANTIC_COLORS.textPrimary}
              fontFamily={TYPOGRAPHY.fontDisplay}
              textAlign="center"
            >
              Membrane Dashboard
            </Text>
            <Text
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textSecondary}
              fontFamily={TYPOGRAPHY.fontMono}
              letterSpacing="1px"
              textAlign="center"
            >
              Revenue, Rates & Liquidation Analytics
            </Text>
          </VStack>

          {/* Stat Cards */}
          <Grid templateColumns={{ base: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)' }} gap={SPACING.base}>
            <StatCard label="Total Gross Revenue" value={`${stats.grossRevenue} CDT`} isLoading={isLoading} />
            <StatCard label="Total Net Revenue" value={`${stats.netRevenue} CDT`} valueColor={ASSET_COLORS[2]} isLoading={isLoading} />
            <StatCard label="Avg Interest Rate" value={stats.avgRate} valueColor={ASSET_COLORS[1]} isLoading={isLoading} />
            <StatCard label="Liquidation Save Rate" value={stats.saveRate} valueColor={SEMANTIC_COLORS.success} isLoading={isLoading} />
          </Grid>

          {/* ── Revenue Chart ── */}
          <VStack spacing={SPACING.md} align="stretch">
            <SectionHeader
              title="Revenue Over Time"
              info="Gross revenue is total protocol interest earned. Net revenue subtracts system discounts granted to users."
            />
            <Box
              h={{ base: '260px', md: '340px' }}
              bg="rgba(0, 0, 0, 0.5)"
              borderRadius={0}
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderMedium}
              p={SPACING.sm}
            >
              {revenueData && revenueData.length > 0 ? (
                <RevenueLineChart data={revenueData} />
              ) : (
                <Skeleton w="100%" h="100%" />
              )}
            </Box>
          </VStack>

          {/* ── Interest Rate Chart ── */}
          <VStack spacing={SPACING.md} align="stretch">
            <SectionHeader
              title="Interest Rates & Spike Height"
              info="Average weighted interest rate across all collateral types. Spike height shows how far rates deviate during demand surges. Lower spikes are Membrane's USP."
            />
            <Box
              h={{ base: '260px', md: '340px' }}
              bg="rgba(0, 0, 0, 0.5)"
              borderRadius={0}
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderMedium}
              p={SPACING.sm}
            >
              {rateData && rateData.length > 0 ? (
                <RateLineChart data={rateData} avgBaseRate={avgBaseRate} />
              ) : (
                <Skeleton w="100%" h="100%" />
              )}
            </Box>
          </VStack>

          {/* ── Liquidation Funnel Chart ── */}
          <VStack spacing={SPACING.md} align="stretch">
            <SectionHeader
              title="Liquidation Outcomes"
              info="Tracks positions that triggered liquidation. 'Saved by Delay' = positions rescued during the grace window. 'Window Expired' = delay ended, position liquidated. 'Window Broken' = price broke the threshold during delay."
            />
            <Box
              h={{ base: '280px', md: '360px' }}
              bg="rgba(0, 0, 0, 0.5)"
              borderRadius={0}
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderMedium}
              p={SPACING.sm}
            >
              {liqData && liqData.length > 0 ? (
                <LiquidationBarChart data={liqData} />
              ) : (
                <Skeleton w="100%" h="100%" />
              )}
            </Box>
          </VStack>
        </VStack>
      </Box>
    </Box>
  )
}

export default MembraneDashboard
