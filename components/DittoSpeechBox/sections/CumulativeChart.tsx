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

export interface CumulativeChartDataPoint {
    timestamp: number
    volume: number
}

interface CumulativeChartProps {
    data: CumulativeChartDataPoint[]
    isLoading?: boolean
    label?: string
}

const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
        const data = payload[0].payload as CumulativeChartDataPoint
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
                    Volume: ${data.volume.toFixed(2)}
                </Text>
            </Box>
        )
    }
    return null
}

export const CumulativeChart: React.FC<CumulativeChartProps> = ({
    data,
    isLoading,
    label = "Cumulative Volume"
}) => {
    console.log('[CumulativeChart] Rendering with data:', {
        dataLength: data?.length,
        isLoading,
        firstPoint: data?.[0],
        lastPoint: data?.[data?.length - 1]
    })

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
        console.log('[CumulativeChart] No data available')
        return (
            <Box h="200px" display="flex" alignItems="center" justifyContent="center">
                <VStack spacing={2}>
                    <Text color="#F5F5F580" fontSize="sm">
                        No volume data available
                    </Text>
                    <Text color="#F5F5F540" fontSize="xs">
                        Volume data will appear here over time
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

    // Format volume for Y-axis (abbreviate large numbers)
    const formatVolume = (value: number) => {
        if (value >= 1_000_000) {
            return `$${(value / 1_000_000).toFixed(1)}M`
        }
        if (value >= 1_000) {
            return `$${(value / 1_000).toFixed(1)}K`
        }
        return `$${value.toFixed(0)}`
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
                        tickFormatter={formatVolume}
                        tick={{ fontSize: 10, fill: '#F5F5F580' }}
                        axisLine={{ stroke: '#6943FF40' }}
                        tickLine={{ stroke: '#6943FF40' }}
                    />
                    <RechartsTooltip content={<CustomTooltip />} />
                    <Line
                        type="monotone"
                        dataKey="volume"
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

