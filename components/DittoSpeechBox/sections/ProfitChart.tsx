import React from 'react'
import { Box, Text, VStack } from '@chakra-ui/react'
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    ResponsiveContainer,
    Tooltip as RechartsTooltip,
    CartesianGrid,
} from 'recharts'
import { ChartDataPoint } from '@/services/manic'

interface ProfitChartProps {
    data: ChartDataPoint[]
    isLoading?: boolean
}

const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
        const data = payload[0].payload as ChartDataPoint
        const date = new Date(data.timestamp * 1000)
        return (
            <Box
                bg="#23252B"
                border="1px solid"
                borderColor="cyan.500"
                borderRadius="md"
                p={2}
                fontSize="xs"
            >
                <Text color="cyan.400" fontWeight="bold" mb={1}>
                    {date.toLocaleDateString()} {date.toLocaleTimeString()}
                </Text>
                <Text color="#F5F5F5">
                    Profit: ${data.profit.toFixed(2)}
                </Text>
                {data.apr !== undefined && (
                    <Text color="green.400" fontSize="xs">
                        APR: {data.apr.toFixed(2)}%
                    </Text>
                )}
                {data.collateralValue !== undefined && (
                    <Text color="#F5F5F580" fontSize="xs">
                        Collateral: ${data.collateralValue.toFixed(2)}
                    </Text>
                )}
                {data.debt !== undefined && (
                    <Text color="#F5F5F580" fontSize="xs">
                        Debt: ${data.debt.toFixed(2)}
                    </Text>
                )}
            </Box>
        )
    }
    return null
}

export const ProfitChart: React.FC<ProfitChartProps> = ({ data, isLoading }) => {
    if (isLoading) {
        return (
            <Box h="200px" display="flex" alignItems="center" justifyContent="center">
                <Text color="#F5F5F580" fontSize="sm">
                    Loading chart data...
                </Text>
            </Box>
        )
    }

    if (!data || data.length === 0) {
        return (
            <Box h="200px" display="flex" alignItems="center" justifyContent="center">
                <VStack spacing={2}>
                    <Text color="#F5F5F580" fontSize="sm">
                        No profit data available
                    </Text>
                    <Text color="#F5F5F540" fontSize="xs">
                        Start looping to see your profit over time
                    </Text>
                </VStack>
            </Box>
        )
    }

    // Format timestamp for X-axis
    const formatDate = (timestamp: number) => {
        const date = new Date(timestamp * 1000)
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    }

    return (
        <Box w="100%" h="250px" mt={4}>
            <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#6943FF20" />
                    <XAxis
                        dataKey="timestamp"
                        tickFormatter={formatDate}
                        tick={{ fontSize: 10, fill: '#F5F5F580' }}
                        axisLine={{ stroke: '#6943FF40' }}
                        tickLine={{ stroke: '#6943FF40' }}
                    />
                    <YAxis
                        tickFormatter={(value) => `$${value.toFixed(0)}`}
                        tick={{ fontSize: 10, fill: '#F5F5F580' }}
                        axisLine={{ stroke: '#6943FF40' }}
                        tickLine={{ stroke: '#6943FF40' }}
                    />
                    <RechartsTooltip content={<CustomTooltip />} />
                    <Line
                        type="monotone"
                        dataKey="profit"
                        stroke="#00BFFF"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, fill: '#00BFFF' }}
                    />
                </LineChart>
            </ResponsiveContainer>
        </Box>
    )
}

