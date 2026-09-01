import React from 'react'
import { Box, Text, VStack } from '@chakra-ui/react'
import { lazyChart } from '@/components/ui/lazyChart'
import { ChartDataPoint } from '@/services/manic'

import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'

interface ProfitChartProps {
    data: ChartDataPoint[]
    isLoading?: boolean
}

// Format timestamp for X-axis
const formatDate = (timestamp: number) => {
    const date = new Date(timestamp * 1000)
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
        const data = payload[0].payload as ChartDataPoint
        const date = new Date(data.timestamp * 1000)
        return (
            <Box
                bg={SEMANTIC_COLORS.bgTertiary}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderSubtle}
                borderRadius={0}
                p={SPACING.sm}
                fontSize="xs"
            >
                <Text color={SEMANTIC_COLORS.info} fontWeight="bold" mb={1}>
                    {date.toLocaleDateString()} {date.toLocaleTimeString()}
                </Text>
                <Text color={SEMANTIC_COLORS.textPrimary}>
                    Profit: ${data.profit.toFixed(2)}
                </Text>
                {data.apr !== undefined && (
                    <Text color={SEMANTIC_COLORS.success} fontSize="xs">
                        APR: {data.apr.toFixed(2)}%
                    </Text>
                )}
                {data.collateralValue !== undefined && (
                    <Text color={SEMANTIC_COLORS.textSecondary} fontSize="xs">
                        Collateral: ${data.collateralValue.toFixed(2)}
                    </Text>
                )}
                {data.debt !== undefined && (
                    <Text color={SEMANTIC_COLORS.textSecondary} fontSize="xs">
                        Debt: ${data.debt.toFixed(2)}
                    </Text>
                )}
            </Box>
        )
    }
    return null
}

const ProfitLineChart = lazyChart<{ data: ChartDataPoint[] }>(
    ({ LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip: RechartsTooltip, CartesianGrid }) =>
        function ProfitLineChart({ data }) {
            return (
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#9bdc4f20" />
                        <XAxis
                            dataKey="timestamp"
                            tickFormatter={formatDate}
                            tick={{ fontSize: 10, fill: SEMANTIC_COLORS.textSecondary }}
                            axisLine={{ stroke: '#9bdc4f40' }}
                            tickLine={{ stroke: '#9bdc4f40' }}
                        />
                        <YAxis
                            tickFormatter={(value) => `$${value.toFixed(0)}`}
                            tick={{ fontSize: 10, fill: SEMANTIC_COLORS.textSecondary }}
                            axisLine={{ stroke: '#9bdc4f40' }}
                            tickLine={{ stroke: '#9bdc4f40' }}
                        />
                        <RechartsTooltip content={<CustomTooltip />} />
                        <Line
                            type="monotone"
                            dataKey="profit"
                            stroke={SEMANTIC_COLORS.info}
                            strokeWidth={2}
                            dot={false}
                            activeDot={{ r: 4, fill: SEMANTIC_COLORS.info }}
                        />
                    </LineChart>
                </ResponsiveContainer>
            )
        },
    '100%',
)

export const ProfitChart: React.FC<ProfitChartProps> = ({ data, isLoading }) => {
    if (isLoading) {
        return (
            <Box h="200px" display="flex" alignItems="center" justifyContent="center">
                <Text color={SEMANTIC_COLORS.textSecondary} fontSize="sm">
                    Loading chart data...
                </Text>
            </Box>
        )
    }

    if (!data || data.length === 0) {
        return (
            <Box h="200px" display="flex" alignItems="center" justifyContent="center">
                <VStack spacing={2}>
                    <Text color={SEMANTIC_COLORS.textSecondary} fontSize="sm">
                        No profit data available
                    </Text>
                    <Text color={SEMANTIC_COLORS.textTertiary} fontSize="xs">
                        Start looping to see your profit over time
                    </Text>
                </VStack>
            </Box>
        )
    }

    return (
        <Box w="100%" h="250px" mt={4}>
            <ProfitLineChart data={data} />
        </Box>
    )
}

