import React, { useMemo } from 'react'
import {
    VStack,
    HStack,
    Text,
    Box,
    SimpleGrid,
    Badge,
    Spinner,
} from '@chakra-ui/react'
import {
    LineChart,
    Line,
    AreaChart,
    Area,
    ComposedChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    Legend,
    ScatterChart,
    Scatter,
} from 'recharts'
import type { TimelineData, SystemEvent } from '@/types/visualization'
import { DEFAULT_VIS_CONFIG } from '@/types/visualization'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

dayjs.extend(relativeTime)

interface GlobalTimelineProps {
    data: TimelineData
    events: SystemEvent[]
    timeRange: '1h' | '24h' | '7d' | '30d'
    isLoading: boolean
}

export const GlobalTimeline: React.FC<GlobalTimelineProps> = ({
    data,
    events,
    timeRange,
    isLoading,
}) => {
    // Combine timeline data
    const chartData = useMemo(() => {
        const maxLength = Math.max(
            data.timestamps.length,
            data.cdtSupply.length,
            data.mbrnAtRisk.length
        )

        return Array(maxLength)
            .fill(0)
            .map((_, i) => ({
                timestamp: data.timestamps[i] || 0,
                time: data.timestamps[i]
                    ? dayjs.unix(data.timestamps[i]).format(timeRange === '1h' ? 'HH:mm' : 'MM/DD HH:mm')
                    : '',
                cdtSupply: data.cdtSupply[i] || 0,
                mbrnAtRisk: data.mbrnAtRisk[i] || 0,
                cdtSupplyFormatted: data.cdtSupply[i] ? `$${(data.cdtSupply[i] / 1e6).toFixed(2)}M` : 'N/A',
                mbrnAtRiskFormatted: data.mbrnAtRisk[i] ? `$${(data.mbrnAtRisk[i] / 1e6).toFixed(2)}M` : 'N/A',
            }))
    }, [data, timeRange])

    // Liquidation clusters data
    const liquidationData = useMemo(() => {
        return data.liquidationClusters.map(cluster => ({
            time: dayjs.unix(cluster.timestamp).format(timeRange === '1h' ? 'HH:mm' : 'MM/DD HH:mm'),
            timestamp: cluster.timestamp,
            count: cluster.count,
            totalAmount: cluster.totalAmount,
            amountFormatted: `$${(cluster.totalAmount / 1e6).toFixed(2)}M`,
        }))
    }, [data.liquidationClusters, timeRange])

    // Event distribution by type
    const eventDistribution = useMemo(() => {
        const distribution: Record<string, number> = {}
        events.forEach(event => {
            distribution[event.type] = (distribution[event.type] || 0) + 1
        })
        return Object.entries(distribution).map(([type, count]) => ({
            type: type.replace('_', ' ').toUpperCase(),
            count,
        }))
    }, [events])

    // Risk metrics over time
    const riskData = useMemo(() => {
        return data.riskMetrics.map(metric => ({
            time: dayjs.unix(metric.timestamp).format(timeRange === '1h' ? 'HH:mm' : 'MM/DD HH:mm'),
            overallRisk: metric.overallRisk * 100,
            timestamp: metric.timestamp,
        }))
    }, [data.riskMetrics, timeRange])

    if (isLoading) {
        return (
            <Box
                w="100%"
                h="100%"
                display="flex"
                alignItems="center"
                justifyContent="center"
            >
                <VStack spacing={4}>
                    <Spinner size="xl" color="purple.400" />
                    <Text color="purple.300" fontFamily="mono">
                        Loading timeline data...
                    </Text>
                </VStack>
            </Box>
        )
    }

    return (
        <VStack align="stretch" spacing={6} h="100%" overflowY="auto">
            {/* Header Stats */}
            <SimpleGrid columns={4} spacing={4}>
                <Box
                    p={4}
                    bg="rgba(10, 10, 15, 0.95)"
                    border="1px solid"
                    borderColor="rgba(138, 43, 226, 0.3)"
                    borderRadius="lg"
                >
                    <Text fontSize="xs" color="purple.400" mb={1} fontFamily="mono">
                        CDT Supply
                    </Text>
                    <Text fontSize="xl" fontWeight="bold" color="#00bfff" fontFamily="mono">
                        {chartData.length > 0 && chartData[chartData.length - 1].cdtSupplyFormatted}
                    </Text>
                </Box>
                <Box
                    p={4}
                    bg="rgba(10, 10, 15, 0.95)"
                    border="1px solid"
                    borderColor="rgba(138, 43, 226, 0.3)"
                    borderRadius="lg"
                >
                    <Text fontSize="xs" color="purple.400" mb={1} fontFamily="mono">
                        MBRN At Risk
                    </Text>
                    <Text fontSize="xl" fontWeight="bold" color="#ff00ff" fontFamily="mono">
                        {chartData.length > 0 && chartData[chartData.length - 1].mbrnAtRiskFormatted}
                    </Text>
                </Box>
                <Box
                    p={4}
                    bg="rgba(10, 10, 15, 0.95)"
                    border="1px solid"
                    borderColor="rgba(138, 43, 226, 0.3)"
                    borderRadius="lg"
                >
                    <Text fontSize="xs" color="purple.400" mb={1} fontFamily="mono">
                        Liquidations
                    </Text>
                    <Text fontSize="xl" fontWeight="bold" color="#ff0000" fontFamily="mono">
                        {liquidationData.reduce((sum, d) => sum + d.count, 0)}
                    </Text>
                </Box>
                <Box
                    p={4}
                    bg="rgba(10, 10, 15, 0.95)"
                    border="1px solid"
                    borderColor="rgba(138, 43, 226, 0.3)"
                    borderRadius="lg"
                >
                    <Text fontSize="xs" color="purple.400" mb={1} fontFamily="mono">
                        Total Events
                    </Text>
                    <Text fontSize="xl" fontWeight="bold" color="#8a2be2" fontFamily="mono">
                        {events.length}
                    </Text>
                </Box>
            </SimpleGrid>

            {/* CDT Supply & MBRN Timeline */}
            <Box
                p={4}
                bg="rgba(10, 10, 15, 0.95)"
                border="1px solid"
                borderColor="rgba(138, 43, 226, 0.3)"
                borderRadius="lg"
            >
                <Text fontSize="sm" fontWeight="bold" mb={4} color="purple.300" fontFamily="mono">
                    CDT Supply & MBRN At Risk
                </Text>
                <ResponsiveContainer width="100%" height={300}>
                    <ComposedChart data={chartData}>
                        <defs>
                            <linearGradient id="colorCDT" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#00bfff" stopOpacity={0.8} />
                                <stop offset="95%" stopColor="#00bfff" stopOpacity={0} />
                            </linearGradient>
                            <linearGradient id="colorMBRN" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#ff00ff" stopOpacity={0.8} />
                                <stop offset="95%" stopColor="#ff00ff" stopOpacity={0} />
                            </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(138, 43, 226, 0.2)" />
                        <XAxis
                            dataKey="time"
                            tick={{ fill: '#8a2be2', fontSize: 10 }}
                            interval="preserveStartEnd"
                        />
                        <YAxis
                            yAxisId="left"
                            tick={{ fill: '#00bfff', fontSize: 10 }}
                        />
                        <YAxis
                            yAxisId="right"
                            orientation="right"
                            tick={{ fill: '#ff00ff', fontSize: 10 }}
                        />
                        <Tooltip
                            contentStyle={{
                                backgroundColor: 'rgba(10, 10, 15, 0.95)',
                                border: '1px solid rgba(138, 43, 226, 0.5)',
                                borderRadius: '4px',
                                color: '#8a2be2',
                            }}
                        />
                        <Legend />
                        <Area
                            yAxisId="left"
                            type="monotone"
                            dataKey="cdtSupply"
                            stroke="#00bfff"
                            fill="url(#colorCDT)"
                            name="CDT Supply"
                        />
                        <Area
                            yAxisId="right"
                            type="monotone"
                            dataKey="mbrnAtRisk"
                            stroke="#ff00ff"
                            fill="url(#colorMBRN)"
                            name="MBRN At Risk"
                        />
                    </ComposedChart>
                </ResponsiveContainer>
            </Box>

            {/* Liquidation Clusters */}
            {liquidationData.length > 0 && (
                <Box
                    p={4}
                    bg="rgba(10, 10, 15, 0.95)"
                    border="1px solid"
                    borderColor="rgba(138, 43, 226, 0.3)"
                    borderRadius="lg"
                >
                    <Text fontSize="sm" fontWeight="bold" mb={4} color="purple.300" fontFamily="mono">
                        Liquidation Clusters
                    </Text>
                    <ResponsiveContainer width="100%" height={250}>
                        <ScatterChart data={liquidationData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(138, 43, 226, 0.2)" />
                            <XAxis
                                dataKey="time"
                                tick={{ fill: '#8a2be2', fontSize: 10 }}
                                interval="preserveStartEnd"
                            />
                            <YAxis
                                dataKey="count"
                                tick={{ fill: '#ff0000', fontSize: 10 }}
                                label={{ value: 'Liquidations', angle: -90, position: 'insideLeft', fill: '#ff0000' }}
                            />
                            <Tooltip
                                contentStyle={{
                                    backgroundColor: 'rgba(10, 10, 15, 0.95)',
                                    border: '1px solid rgba(138, 43, 226, 0.5)',
                                    borderRadius: '4px',
                                    color: '#8a2be2',
                                }}
                                cursor={{ strokeDasharray: '3 3' }}
                            />
                            <Scatter
                                name="Liquidations"
                                dataKey="count"
                                fill="#ff0000"
                                shape={(props: any) => {
                                    const { cx, cy, payload } = props
                                    const size = Math.max(5, Math.min(20, payload.count * 2))
                                    return (
                                        <circle
                                            cx={cx}
                                            cy={cy}
                                            r={size}
                                            fill="#ff0000"
                                            fillOpacity={0.6}
                                            stroke="#ff0000"
                                            strokeWidth={2}
                                        />
                                    )
                                }}
                            />
                        </ScatterChart>
                    </ResponsiveContainer>
                </Box>
            )}

            {/* Risk Metrics */}
            {riskData.length > 0 && (
                <Box
                    p={4}
                    bg="rgba(10, 10, 15, 0.95)"
                    border="1px solid"
                    borderColor="rgba(138, 43, 226, 0.3)"
                    borderRadius="lg"
                >
                    <Text fontSize="sm" fontWeight="bold" mb={4} color="purple.300" fontFamily="mono">
                        Overall Risk Over Time
                    </Text>
                    <ResponsiveContainer width="100%" height={200}>
                        <LineChart data={riskData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(138, 43, 226, 0.2)" />
                            <XAxis
                                dataKey="time"
                                tick={{ fill: '#8a2be2', fontSize: 10 }}
                                interval="preserveStartEnd"
                            />
                            <YAxis
                                domain={[0, 100]}
                                tick={{ fill: '#ff8800', fontSize: 10 }}
                                label={{ value: 'Risk %', angle: -90, position: 'insideLeft', fill: '#ff8800' }}
                            />
                            <Tooltip
                                contentStyle={{
                                    backgroundColor: 'rgba(10, 10, 15, 0.95)',
                                    border: '1px solid rgba(138, 43, 226, 0.5)',
                                    borderRadius: '4px',
                                    color: '#8a2be2',
                                }}
                            />
                            <Line
                                type="monotone"
                                dataKey="overallRisk"
                                stroke="#ff8800"
                                strokeWidth={2}
                                dot={{ fill: '#ff8800', r: 3 }}
                                name="Risk %"
                            />
                        </LineChart>
                    </ResponsiveContainer>
                </Box>
            )}

            {/* Event Distribution */}
            {eventDistribution.length > 0 && (
                <Box
                    p={4}
                    bg="rgba(10, 10, 15, 0.95)"
                    border="1px solid"
                    borderColor="rgba(138, 43, 226, 0.3)"
                    borderRadius="lg"
                >
                    <Text fontSize="sm" fontWeight="bold" mb={4} color="purple.300" fontFamily="mono">
                        Event Distribution
                    </Text>
                    <HStack spacing={2} wrap="wrap">
                        {eventDistribution.map((item) => (
                            <Badge
                                key={item.type}
                                px={3}
                                py={1}
                                borderRadius="full"
                                colorScheme="purple"
                                variant="outline"
                                fontFamily="mono"
                            >
                                {item.type}: {item.count}
                            </Badge>
                        ))}
                    </HStack>
                </Box>
            )}
        </VStack>
    )
}

