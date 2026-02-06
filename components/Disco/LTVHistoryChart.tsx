import React, { useMemo } from 'react'
import { Box, VStack, Text } from '@chakra-ui/react'
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    Tooltip as RechartsTooltip,
    ResponsiveContainer,
    Legend,
} from 'recharts'
import { useDailyLTV } from '@/hooks/useDiscoData'
import { mockDailyLTV } from './mockData'

// Color constants
const PRIMARY_PURPLE = 'rgb(166, 146, 255)'
const CYAN = 'rgb(34, 211, 238)'

interface LTVHistoryChartProps {
    asset: string
    assetSymbol?: string
    ltvQueue?: any // The LTV queue data from the contract
}

export const LTVHistoryChart: React.FC<LTVHistoryChartProps> = ({ asset, assetSymbol, ltvQueue }) => {
    const { data: dailyLTV, isLoading } = useDailyLTV(asset)

    // Use mock data if real data is not available
    const useMockData = !dailyLTV || !dailyLTV.entries || dailyLTV.entries.length === 0
    const dailyLTVToUse = useMockData ? mockDailyLTV.entries : (dailyLTV?.entries || [])

    // Process chart data
    const chartData = useMemo(() => {
        if (!dailyLTVToUse || dailyLTVToUse.length === 0) {
            return []
        }

        return dailyLTVToUse.map((entry: any) => {
            // Convert Decimal strings to numbers
            const avgMaxLTV = typeof entry.average_max_ltv === 'string'
                ? parseFloat(entry.average_max_ltv)
                : entry.average_max_ltv
            const avgMaxBorrowLTV = typeof entry.average_max_borrow_ltv === 'string'
                ? parseFloat(entry.average_max_borrow_ltv)
                : entry.average_max_borrow_ltv

            return {
                date: new Date(entry.timestamp * 1000).toLocaleDateString(),
                timestamp: entry.timestamp,
                liquidationLTV: avgMaxLTV * 100, // Convert to percentage
                borrowLTV: avgMaxBorrowLTV * 100, // Convert to percentage
            }
        })
    }, [dailyLTV])

    // Extract min/max for Y-axis domain from LTV queue if available, otherwise from data
    // NOTE: This hook must be called before any early returns to follow Rules of Hooks
    const { minLTV, maxLTV } = useMemo(() => {
        // If we have the LTV queue, use its min/max ranges
        if (ltvQueue?.queue) {
            const borrowRange = ltvQueue.queue.borrow_ltv
            const liquidationRange = ltvQueue.queue.liquidation_ltv

            // Parse Decimal values (can be string or number)
            const parseDecimal = (val: any): number => {
                if (typeof val === 'string') {
                    return parseFloat(val)
                }
                if (typeof val === 'number') {
                    return val
                }
                if (val?.toString) {
                    return parseFloat(val.toString())
                }
                return 0
            }

            const borrowMin = parseDecimal(borrowRange?.min) * 100
            const borrowMax = parseDecimal(borrowRange?.max) * 100
            const liquidationMin = parseDecimal(liquidationRange?.min) * 100
            const liquidationMax = parseDecimal(liquidationRange?.max) * 100

            // Use the overall min/max across both ranges
            const min = Math.min(borrowMin, liquidationMin)
            const max = Math.max(borrowMax, liquidationMax)

            // Add 2% padding
            return {
                minLTV: Math.floor(Math.max(0, min - 2)),
                maxLTV: Math.ceil(Math.min(100, max + 2)),
            }
        }

        // Fallback to calculating from chart data
        if (!chartData || chartData.length === 0) {
            return { minLTV: 60, maxLTV: 90 }
        }
        const allLTVs = chartData.flatMap((d: any) => [d.liquidationLTV, d.borrowLTV])
        const min = Math.max(0, Math.min(...allLTVs) - 2) // Add 2% padding below
        const max = Math.min(100, Math.max(...allLTVs) + 2) // Add 2% padding above
        return {
            minLTV: Math.floor(min),
            maxLTV: Math.ceil(max),
        }
    }, [ltvQueue, chartData])

    // Early returns after all hooks are called
    if (isLoading) {
        return (
            <Box
                w="100%"
                maxW="1400px"
                h="100%"
                mx="auto"
                p={8}
                bg="rgba(10, 10, 10, 0.8)"
                borderRadius="md"
                border="2px solid"
                borderColor={PRIMARY_PURPLE}
                boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
            >
                <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="1px">
                    Loading LTV History...
                </Text>
            </Box>
        )
    }

    if (!chartData || chartData.length === 0) {
        return (
            <Box
                w="100%"
                maxW="1400px"
                mx="auto"
                p={8}
                bg="rgba(10, 10, 10, 0.8)"
                borderRadius="md"
                border="2px solid"
                borderColor={PRIMARY_PURPLE}
                boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
            >
                <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="1px">
                    No LTV history available
                </Text>
            </Box>
        )
    }

    return (
        <Box
            w="100%"
            maxW="1400px"
            mx="auto"
            p={4}
            bg="rgba(10, 10, 10, 0.8)"
            borderRadius="md"
            border="2px solid"
            borderColor={PRIMARY_PURPLE}
            position="relative"
            boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
        >
            <VStack align="stretch" spacing={1}>
                <Text
                    fontSize="xl"
                    fontWeight="bold"
                    color={PRIMARY_PURPLE}
                    fontFamily="mono"
                    letterSpacing="2px"
                    textTransform="uppercase"
                >
                    {assetSymbol || asset} LTV History
                </Text>
                <Text fontSize="sm" color="whiteAlpha.600" fontFamily="mono" mt={-1}>
                    Historical average LTV values for {assetSymbol || asset}
                </Text>
                <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={chartData}>
                        <XAxis
                            dataKey="date"
                            stroke={PRIMARY_PURPLE}
                            strokeOpacity={0.6}
                            tick={{ fill: PRIMARY_PURPLE, fontFamily: 'mono', fontSize: '10px', letterSpacing: '2px', fontWeight: 700 }}
                            interval="preserveStartEnd"
                            tickFormatter={(value, index) => {
                                // Show only weekly dates (every 7 days)
                                if (chartData.length === 0) return value
                                const entry = chartData[index]
                                if (!entry || !entry.timestamp) return value

                                // Get the first entry's timestamp as reference
                                const firstTimestamp = chartData[0]?.timestamp || 0
                                const daysSinceStart = Math.floor((entry.timestamp - firstTimestamp) / 86400)

                                // Show date if it's a multiple of 7 days, or if it's the first/last entry
                                if (daysSinceStart % 7 === 0 || index === 0 || index === chartData.length - 1) {
                                    return value
                                }
                                return ''
                            }}
                        />
                        <YAxis
                            stroke={PRIMARY_PURPLE}
                            strokeOpacity={0.6}
                            tick={{ fill: PRIMARY_PURPLE, fontFamily: 'mono', fontSize: '10px', letterSpacing: '2px', fontWeight: 700 }}
                            label={{ value: 'LTV %', angle: -90, position: 'insideLeft', fill: PRIMARY_PURPLE, fontFamily: 'mono', letterSpacing: '2px', fontWeight: 700, fontSize: '12px' }}
                            domain={[minLTV, maxLTV]}
                        />
                        <RechartsTooltip
                            contentStyle={{
                                backgroundColor: 'rgba(10, 10, 10, 0.95)',
                                border: `2px solid ${PRIMARY_PURPLE}`,
                                borderRadius: '4px',
                                color: PRIMARY_PURPLE,
                                fontFamily: 'mono',
                            }}
                            formatter={(value: any, name: string, props: any) => {
                                const formattedValue = typeof value === 'number'
                                    ? value.toFixed(2)
                                    : parseFloat(value || '0').toFixed(2)
                                const dataKey = props.dataKey
                                const label = dataKey === 'liquidationLTV' ? 'Liquidation LTV' : 'Borrow LTV'
                                return [`${formattedValue}%`, label]
                            }}
                            labelFormatter={(label) => `Date: ${label}`}
                            itemSorter={(item) => {
                                // Ensure Liquidation LTV appears first
                                if (item.dataKey === 'liquidationLTV') return -1
                                if (item.dataKey === 'borrowLTV') return 1
                                return 0
                            }}
                        />
                        <Legend
                            wrapperStyle={{ fontFamily: 'mono', color: PRIMARY_PURPLE }}
                            iconType="line"
                        />
                        <Line
                            type="monotone"
                            dataKey="liquidationLTV"
                            stroke={PRIMARY_PURPLE}
                            strokeWidth={2}
                            name="Liquidation LTV"
                            dot={false}
                            activeDot={{ r: 5 }}
                        />
                        <Line
                            type="monotone"
                            dataKey="borrowLTV"
                            stroke={CYAN}
                            strokeWidth={2}
                            name="Borrow LTV"
                            dot={false}
                            activeDot={{ r: 5 }}
                        />
                    </LineChart>
                </ResponsiveContainer>
            </VStack>
        </Box>
    )
}

