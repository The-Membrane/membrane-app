import React, { useMemo, useState } from 'react'
import { Box, HStack, VStack, Text, Button, ButtonGroup, useBreakpointValue } from '@chakra-ui/react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Legend,
  ReferenceArea,
  ReferenceLine,
  CartesianGrid,
} from 'recharts'
import { useUserPositions, useBasket } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { getPositions } from '@/services/cdp'
import { useChainRoute } from '@/hooks/useChainRoute'
import useAppState from '@/persisted-state/useAppState'
import { num } from '@/helpers/num'
import usePriceHistory, { getAlignedTimestamps, getPriceAtTimestamp } from './hooks/usePriceHistory'
import { ChartDataPoint, TimeRange, getSymbolFromDenom, MOCK_CHART_DENOMS } from './types'
import { CHART_THEME, ASSET_COLORS, REFERENCE_STYLES, createCustomLegend } from '@/config/chartTheme'

// Color constants
const CYAN = ASSET_COLORS[0] // Use first color from theme
const LIQUIDATION_RED = 'rgba(239, 68, 68, 0.3)'

// Mock asset config for demo when no position exists
// Target split: NTRN 40%, BTC 40%, USDC 20%
const MOCK_ASSET_CONFIG = [
  { denom: 'untrn', symbol: 'NTRN', weight: 0.4 },
  { denom: 'factory/osmo1z0qrq605sjgcqpylfl4aa6s90x738j7m58wyatt0tdzflg2ha26q67k743/wbtc', symbol: 'BTC', weight: 0.4 },
  { denom: 'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4', symbol: 'USDC', weight: 0.2 },
]
const MOCK_TOTAL_VALUE = 10000 // $10,000 total portfolio value for mock
const MOCK_LIQUIDATION_VALUE = 8000 // Mock liquidation threshold (80% LTV of $10k)

interface PositionPerformanceChartProps {
  positionIndex?: number
  liquidationValue?: number
}

export const PositionPerformanceChart: React.FC<PositionPerformanceChartProps> = ({
  positionIndex = 0,
  liquidationValue = 0,
}) => {
  const [timeRange, setTimeRange] = useState<TimeRange>(30)
  const { chainName } = useChainRoute()
  const { appState } = useAppState()
  const { data: prices } = useOraclePrice()
  const { data: basketPositions } = useUserPositions()
  const { data: basket } = useBasket(appState.rpcUrl)

  // Responsive chart height
  const chartHeight = useBreakpointValue({ base: 200, md: 250, lg: 300 }) ?? 250

  // Get user's current positions
  const positions = useMemo(() => {
    if (!basketPositions || basketPositions.length === 0 || !prices) {
      return []
    }
    return getPositions(basketPositions, prices, positionIndex, chainName) || []
  }, [basketPositions, prices, positionIndex, chainName])

  // Check if user has a position
  const hasPosition = positions.length > 0 && positions.some(p => p && num(p.amount).isGreaterThan(0))

  // Get denoms for price history - use mock if no position
  const denoms = useMemo(() => {
    if (hasPosition) {
      return positions
        .filter(p => p && num(p.amount).isGreaterThan(0))
        .map(p => p.denom)
    }
    // Use mock denoms when no position
    return MOCK_CHART_DENOMS
  }, [positions, hasPosition])

  // Fetch historical price data
  const { data: priceHistory, isLoading: priceLoading } = usePriceHistory(denoms, timeRange, appState.rpcUrl)

  // Process chart data
  const { chartData, minValue, maxValue, assets } = useMemo(() => {
    if (!priceHistory) {
      return { chartData: [], minValue: 0, maxValue: 0, assets: [] }
    }

    // Get aligned timestamps across all assets
    const timestamps = getAlignedTimestamps(priceHistory)
    if (timestamps.length === 0) {
      return { chartData: [], minValue: 0, maxValue: 0, assets: [] }
    }

    const initialTimestamp = timestamps[0]

    // Use real positions or calculate mock assets with 40-40-20 split
    let assetsToUse: Array<{ denom: string; symbol: string; amount: number }>

    if (hasPosition) {
      assetsToUse = positions
        .filter(p => p && num(p.amount).isGreaterThan(0))
        .map(p => ({
          denom: p.denom,
          symbol: p.symbol || getSymbolFromDenom(p.denom, basket),
          amount: p.amount || 0,
        }))
    } else {
      // Calculate mock amounts based on initial prices to maintain 40-40-20 split
      assetsToUse = MOCK_ASSET_CONFIG.map(config => {
        const initialPrice = getPriceAtTimestamp(priceHistory, config.denom, initialTimestamp)
        // Calculate amount needed to achieve target weight
        // amount = (total_value * weight) / price
        const targetValue = MOCK_TOTAL_VALUE * config.weight
        const amount = initialPrice > 0 ? targetValue / initialPrice : 0
        return {
          denom: config.denom,
          symbol: config.symbol,
          amount,
        }
      })
    }

    // Calculate position values at each timestamp
    const data: ChartDataPoint[] = []
    let minVal = Infinity
    let maxVal = -Infinity

    // Calculate initial position value at start of time series
    let initialPositionValue = 0

    assetsToUse.forEach(asset => {
      const initialPrice = getPriceAtTimestamp(priceHistory, asset.denom, initialTimestamp)
      const assetValue = num(asset.amount).times(initialPrice).toNumber()
      initialPositionValue += assetValue
    })

    // Generate chart data for each timestamp
    timestamps.forEach((timestamp) => {
      const date = new Date(timestamp).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      })

      // Calculate actual position value at this timestamp
      let actualValue = 0
      assetsToUse.forEach(asset => {
        const price = getPriceAtTimestamp(priceHistory, asset.denom, timestamp)
        actualValue += num(asset.amount).times(price).toNumber()
      })

      // Calculate hypothetical values for each asset
      // Formula: (initial_position_value / initial_asset_price) * current_asset_price
      const hypotheticals: Record<string, number> = {}
      assetsToUse.forEach(asset => {
        const initialPrice = getPriceAtTimestamp(priceHistory, asset.denom, initialTimestamp)
        const currentPrice = getPriceAtTimestamp(priceHistory, asset.denom, timestamp)

        if (initialPrice > 0) {
          const hypoValue = (initialPositionValue / initialPrice) * currentPrice
          hypotheticals[`hypo_${asset.symbol}`] = hypoValue

          // Track min/max
          if (hypoValue < minVal) minVal = hypoValue
          if (hypoValue > maxVal) maxVal = hypoValue
        }
      })

      // Track min/max for actual value
      if (actualValue < minVal) minVal = actualValue
      if (actualValue > maxVal) maxVal = actualValue

      data.push({
        date,
        timestamp,
        actual: actualValue,
        ...hypotheticals,
      })
    })

    // Include liquidation value in min/max calculation (real or mock)
    const effectiveLiquidation = liquidationValue > 0 ? liquidationValue : (!hasPosition ? MOCK_LIQUIDATION_VALUE : 0)
    if (effectiveLiquidation > 0) {
      if (effectiveLiquidation < minVal) minVal = effectiveLiquidation
    }

    return {
      chartData: data,
      minValue: minVal === Infinity ? 0 : minVal,
      maxValue: maxVal === -Infinity ? 0 : maxVal,
      assets: assetsToUse,
    }
  }, [priceHistory, positions, basket, liquidationValue, hasPosition])

  // Calculate Y-axis domain with padding
  const yDomain = useMemo(() => {
    if (minValue === 0 && maxValue === 0) return [0, 100]
    const padding = (maxValue - minValue) * 0.1
    return [
      Math.max(0, minValue - padding),
      maxValue + padding,
    ]
  }, [minValue, maxValue])

  // Time range buttons
  const timeRanges: TimeRange[] = [7, 30, 90, 180]

  return (
    <Box
      w="100%"
      p={6}
      bg="rgba(10, 10, 10, 0.8)"
      borderRadius="lg"
      border="1px solid"
      borderColor="whiteAlpha.200"
    >
      <VStack align="stretch" spacing={4}>
        <VStack spacing={1}>
          <Text fontSize="lg" fontWeight="bold" color="white" textAlign="center">
            Position Performance
          </Text>
          <Text fontSize="xs" color="whiteAlpha.600" textAlign="center">
            {hasPosition
              ? 'Compare your portfolio vs single-asset allocations'
              : 'Sample: NTRN, BTC & USDC performance comparison'}
          </Text>
        </VStack>

        <HStack justifyContent="center">
          <ButtonGroup size="xs" variant="outline" spacing={1}>
            {timeRanges.map((range) => (
              <Button
                key={range}
                onClick={() => setTimeRange(range)}
                colorScheme={timeRange === range ? 'cyan' : 'gray'}
                variant={timeRange === range ? 'solid' : 'outline'}
              >
                {range}d
              </Button>
            ))}
          </ButtonGroup>
        </HStack>

        {priceLoading ? (
          <Box py={8} textAlign="center">
            <Text color="whiteAlpha.600">Loading price history...</Text>
          </Box>
        ) : chartData.length === 0 ? (
          <Box py={8} textAlign="center">
            <Text color="whiteAlpha.600">No price history available</Text>
          </Box>
        ) : (
          <ResponsiveContainer width="100%" height={chartHeight}>
            <LineChart data={chartData}>
              <CartesianGrid {...CHART_THEME.grid} />

              <XAxis
                {...CHART_THEME.xAxis}
                dataKey="date"
                domain={yDomain}
              />

              <YAxis
                {...CHART_THEME.yAxis}
                domain={yDomain}
                tickFormatter={(value) => `$${num(value).toFixed(0)}`}
              />

              <RechartsTooltip
                {...CHART_THEME.tooltip}
                formatter={(value: number, name: string) => {
                  const displayName = name === 'actual'
                    ? 'Bundled Value'
                    : name.replace('hypo_', '100% ')
                  return [`$${num(value).toFixed(2)}`, displayName]
                }}
                labelFormatter={(label) => `Date: ${label}`}
              />

              <Legend
                content={createCustomLegend((value) => {
                  if (value === 'actual') return 'Bundled Value'
                  return value.replace('hypo_', '100% ')
                })}
              />

              {/* Liquidation Zone - red area from liquidation value to bottom */}
              {(() => {
                const effectiveLiq = liquidationValue > 0 ? liquidationValue : (!hasPosition ? MOCK_LIQUIDATION_VALUE : 0)
                if (effectiveLiq <= 0) return null
                return (
                  <>
                    <ReferenceArea
                      y1={effectiveLiq}
                      y2={yDomain[0]}
                      fill="rgba(239, 68, 68, 0.3)"
                      fillOpacity={1}
                    />
                    <ReferenceLine
                      y={effectiveLiq}
                      stroke="#ef4444"
                      strokeWidth={2}
                      label={{
                        value: 'Liquidation',
                        fill: '#ef4444',
                        fontSize: 10,
                        position: 'right' as const,
                      }}
                    />
                  </>
                )
              })()}

              {/* Actual position value - solid cyan line */}
              <Line
                {...CHART_THEME.line}
                type="monotone"
                dataKey="actual"
                name="actual"
                stroke={CYAN}
              />

              {/* Hypothetical lines - dashed, one per asset */}
              {assets.map((asset, index) => (
                <Line
                  {...CHART_THEME.line}
                  key={asset.denom}
                  type="monotone"
                  dataKey={`hypo_${asset.symbol}`}
                  name={`hypo_${asset.symbol}`}
                  stroke={ASSET_COLORS[index % ASSET_COLORS.length]}
                  strokeWidth={1.5}
                  strokeDasharray="5 5"
                  activeDot={{ r: 4 }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </VStack>
    </Box>
  )
}

export default PositionPerformanceChart
