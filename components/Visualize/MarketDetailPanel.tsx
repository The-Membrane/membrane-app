import React, { useMemo } from 'react'
import {
    VStack,
    HStack,
    Text,
    Box,
    Progress,
    Divider,
    Badge,
    SimpleGrid,
} from '@chakra-ui/react'
import {
    LineChart,
    Line,
    AreaChart,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    RadarChart,
    PolarGrid,
    PolarAngleAxis,
    PolarRadiusAxis,
    Radar,
} from 'recharts'
import type { MarketNode, SystemEvent } from '@/types/visualization'
import { DEFAULT_VIS_CONFIG } from '@/types/visualization'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

dayjs.extend(relativeTime)

interface MarketDetailPanelProps {
    market: MarketNode
    events: SystemEvent[]
    timeRange: '1h' | '24h' | '7d' | '30d'
}

export const MarketDetailPanel: React.FC<MarketDetailPanelProps> = ({
    market,
    events,
    timeRange,
}) => {
    // Process events for time series
    const timeSeriesData = useMemo(() => {
        const now = Date.now()
        const buckets = timeRange === '1h' ? 60 : timeRange === '24h' ? 24 : timeRange === '7d' ? 7 : 30
        const bucketSize = (now - (now - (timeRange === '1h' ? 3600000 : timeRange === '24h' ? 86400000 : timeRange === '7d' ? 604800000 : 2592000000))) / buckets

        const bucketsData = Array(buckets).fill(0).map((_, i) => ({
            time: now - (buckets - i) * bucketSize,
            events: 0,
            volume: 0,
        }))

        events.forEach(event => {
            const bucketIndex = Math.floor((now - event.timestamp * 1000) / bucketSize)
            if (bucketIndex >= 0 && bucketIndex < buckets) {
                bucketsData[bucketIndex].events++
                bucketsData[bucketIndex].volume += event.data.amount || 0
            }
        })

        return bucketsData.map(b => ({
            time: dayjs(b.time).format(timeRange === '1h' ? 'HH:mm' : 'MM/DD HH:mm'),
            events: b.events,
            volume: b.volume,
        }))
    }, [events, timeRange])

    // Risk radar data
    const riskData = useMemo(() => {
        return [
            { subject: 'LTV Risk', value: market.risk * 100, fullMark: 100 },
            { subject: 'Liquidity', value: (1 - market.risk) * 100, fullMark: 100 },
            { subject: 'Activity', value: market.recentActivity * 100, fullMark: 100 },
            { subject: 'Size', value: (market.size / 5) * 100, fullMark: 100 },
        ]
    }, [market])

    // Event stream (recent events)
    const recentEvents = useMemo(() => {
        return events
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, 10)
            .map(event => ({
                ...event,
                timeAgo: dayjs.unix(event.timestamp).fromNow(),
            }))
    }, [events])

    const eventTypeColors = DEFAULT_VIS_CONFIG.colors.event

    return (
        <VStack align="stretch" spacing={4} color="purple.200">
            {/* Header */}
            <VStack align="start" spacing={2}>
                <HStack justify="space-between" w="100%">
                    <Text
                        fontSize="xl"
                        fontWeight="bold"
                        color={market.color}
                        fontFamily="mono"
                    >
                        {market.name}
                    </Text>
                    <Badge
                        colorScheme={market.risk < 0.25 ? 'green' : market.risk < 0.5 ? 'yellow' : market.risk < 0.75 ? 'orange' : 'red'}
                        variant="outline"
                    >
                        {market.type.replace('_', ' ').toUpperCase()}
                    </Badge>
                </HStack>
                <Text fontSize="sm" color="purple.400" fontFamily="mono">
                    {market.metadata.asset || 'N/A'}
                </Text>
            </VStack>

            <Divider borderColor="rgba(138, 43, 226, 0.3)" />

            {/* Metrics Grid */}
            <SimpleGrid columns={2} spacing={4}>
                <Box>
                    <Text fontSize="xs" color="purple.400" mb={1} fontFamily="mono">
                        TVL
                    </Text>
                    <Text fontSize="lg" fontWeight="bold" color={market.color}>
                        ${(market.tvl / 1e6).toFixed(2)}M
                    </Text>
                </Box>
                <Box>
                    <Text fontSize="xs" color="purple.400" mb={1} fontFamily="mono">
                        Risk Score
                    </Text>
                    <HStack>
                        <Progress
                            value={market.risk * 100}
                            colorScheme={market.risk < 0.25 ? 'green' : market.risk < 0.5 ? 'yellow' : market.risk < 0.75 ? 'orange' : 'red'}
                            flex={1}
                            size="sm"
                        />
                        <Text fontSize="sm" color={market.color} fontFamily="mono">
                            {(market.risk * 100).toFixed(0)}%
                        </Text>
                    </HStack>
                </Box>
                {market.ltv !== undefined && (
                    <Box>
                        <Text fontSize="xs" color="purple.400" mb={1} fontFamily="mono">
                            Max LTV
                        </Text>
                        <Text fontSize="lg" fontWeight="bold" color={market.color}>
                            {(market.ltv * 100).toFixed(1)}%
                        </Text>
                    </Box>
                )}
                {market.metadata.maxBorrowLTV !== undefined && (
                    <Box>
                        <Text fontSize="xs" color="purple.400" mb={1} fontFamily="mono">
                            Max Borrow LTV
                        </Text>
                        <Text fontSize="lg" fontWeight="bold" color={market.color}>
                            {(market.metadata.maxBorrowLTV * 100).toFixed(1)}%
                        </Text>
                    </Box>
                )}
            </SimpleGrid>

            <Divider borderColor="rgba(138, 43, 226, 0.3)" />

            {/* Risk Radar */}
            <Box>
                <Text fontSize="sm" fontWeight="bold" mb={2} color="purple.300" fontFamily="mono">
                    Risk Profile
                </Text>
                <ResponsiveContainer width="100%" height={200}>
                    <RadarChart data={riskData}>
                        <PolarGrid stroke="rgba(138, 43, 226, 0.3)" />
                        <PolarAngleAxis
                            dataKey="subject"
                            tick={{ fill: '#8a2be2', fontSize: 10 }}
                        />
                        <PolarRadiusAxis
                            angle={90}
                            domain={[0, 100]}
                            tick={{ fill: '#8a2be2', fontSize: 8 }}
                        />
                        <Radar
                            name="Risk"
                            dataKey="value"
                            stroke={market.color}
                            fill={market.color}
                            fillOpacity={0.3}
                        />
                    </RadarChart>
                </ResponsiveContainer>
            </Box>

            <Divider borderColor="rgba(138, 43, 226, 0.3)" />

            {/* Event Time Series */}
            <Box>
                <Text fontSize="sm" fontWeight="bold" mb={2} color="purple.300" fontFamily="mono">
                    Event Activity
                </Text>
                <ResponsiveContainer width="100%" height={150}>
                    <AreaChart data={timeSeriesData}>
                        <defs>
                            <linearGradient id={`colorEvents-${market.id}`} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor={market.color} stopOpacity={0.8} />
                                <stop offset="95%" stopColor={market.color} stopOpacity={0} />
                            </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(138, 43, 226, 0.2)" />
                        <XAxis
                            dataKey="time"
                            tick={{ fill: '#8a2be2', fontSize: 10 }}
                            interval="preserveStartEnd"
                        />
                        <YAxis tick={{ fill: '#8a2be2', fontSize: 10 }} />
                        <Tooltip
                            contentStyle={{
                                backgroundColor: 'rgba(10, 10, 15, 0.95)',
                                border: '1px solid rgba(138, 43, 226, 0.5)',
                                borderRadius: '4px',
                                color: '#8a2be2',
                            }}
                        />
                        <Area
                            type="monotone"
                            dataKey="events"
                            stroke={market.color}
                            fill={`url(#colorEvents-${market.id})`}
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </Box>

            <Divider borderColor="rgba(138, 43, 226, 0.3)" />

            {/* Event Stream */}
            <Box>
                <Text fontSize="sm" fontWeight="bold" mb={2} color="purple.300" fontFamily="mono">
                    Recent Events
                </Text>
                <VStack align="stretch" spacing={2} maxH="200px" overflowY="auto">
                    {recentEvents.length > 0 ? (
                        recentEvents.map((event) => (
                            <HStack
                                key={event.id}
                                p={2}
                                bg="rgba(138, 43, 226, 0.1)"
                                borderRadius="md"
                                borderLeft="3px solid"
                                borderColor={eventTypeColors[event.type as keyof typeof eventTypeColors] || '#ffffff'}
                            >
                                <Box
                                    w="8px"
                                    h="8px"
                                    borderRadius="full"
                                    bg={eventTypeColors[event.type as keyof typeof eventTypeColors] || '#ffffff'}
                                    boxShadow={`0 0 8px ${eventTypeColors[event.type as keyof typeof eventTypeColors] || '#ffffff'}`}
                                />
                                <VStack align="start" flex={1} spacing={0}>
                                    <Text fontSize="xs" fontWeight="bold" color="purple.200">
                                        {event.type.replace('_', ' ').toUpperCase()}
                                    </Text>
                                    <Text fontSize="xs" color="purple.400">
                                        {event.timeAgo} • {event.data.amount ? `$${(event.data.amount / 1e6).toFixed(2)}M` : 'N/A'}
                                    </Text>
                                </VStack>
                            </HStack>
                        ))
                    ) : (
                        <Text fontSize="xs" color="purple.500" fontFamily="mono" textAlign="center" py={4}>
                            No recent events
                        </Text>
                    )}
                </VStack>
            </Box>
        </VStack>
    )
}

