import React, { useState, useMemo } from 'react'
import {
    Box,
    VStack,
    HStack,
    Text,
    Button,
    ButtonGroup,
} from '@chakra-ui/react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { usePortMetrics } from './hooks/usePortMetrics'
import { useRevenuePerSecond } from './hooks/useRevenuePerSecond'
import usePortState from '@/persisted-state/usePortState'
import dayjs from 'dayjs'
import { ShareButton } from '@/components/ShareableCard/ShareButton'

type TimeRange = 'lifetime' | 'today' | 'session'

export const RevenueChart: React.FC = () => {
    const { data: metrics } = usePortMetrics()
    const { portState } = usePortState()
    const { cumulativeRevenue } = useRevenuePerSecond()
    const [timeRange, setTimeRange] = useState<TimeRange>('lifetime')

    // Generate chart data based on time range
    const chartData = useMemo(() => {
        const now = Date.now()
        let data: Array<{ time: string; revenue: number }> = []
        const currentRevenue = metrics?.totalRevenue || portState.lifetimeRevenue || 463.50 // Mock total revenue

        if (timeRange === 'lifetime') {
            // Use revenue history from state
            const history = portState.revenueHistory || []
            if (history.length === 0) {
                // Generate sample data if no history (mock data)
                for (let i = 30; i >= 0; i--) {
                    const date = dayjs().subtract(i, 'day')
                    data.push({
                        time: date.format('MM/DD'),
                        revenue: currentRevenue * (i / 30),
                    })
                }
            } else {
                history.forEach((entry, index) => {
                    const date = dayjs(entry.timestamp)
                    data.push({
                        time: date.format('MM/DD HH:mm'),
                        revenue: entry.totalRevenue,
                    })
                })
            }
        } else if (timeRange === 'today') {
            // Today's data
            const todayStart = dayjs().startOf('day').valueOf()
            const history = (portState.revenueHistory || []).filter(
                (entry) => entry.timestamp >= todayStart
            )
            if (history.length === 0) {
                // Generate hourly data for today
                for (let i = 0; i < 24; i++) {
                    const hour = dayjs().startOf('day').add(i, 'hour')
                    data.push({
                        time: hour.format('HH:mm'),
                        revenue: (portState.todayRevenue || 0) * (i / 24),
                    })
                }
            } else {
                history.forEach((entry) => {
                    const date = dayjs(entry.timestamp)
                    data.push({
                        time: date.format('HH:mm'),
                        revenue: entry.totalRevenue - (portState.lastSessionRevenue || 0),
                    })
                })
            }
        } else {
            // Session data
            const sessionStart = portState.sessionStartTime
            const history = (portState.revenueHistory || []).filter(
                (entry) => entry.timestamp >= sessionStart
            )
            if (history.length === 0) {
                // Generate minute-by-minute data for session
                const sessionMinutes = Math.floor((now - sessionStart) / 60000)
                for (let i = 0; i <= Math.min(sessionMinutes, 60); i++) {
                    data.push({
                        time: `${i}m`,
                        revenue: (portState.sessionRevenue || 0) * (i / Math.max(sessionMinutes, 1)),
                    })
                }
            } else {
                history.forEach((entry) => {
                    const minutesAgo = Math.floor((now - entry.timestamp) / 60000)
                    data.push({
                        time: `${minutesAgo}m`,
                        revenue: entry.totalRevenue - (portState.lastSessionRevenue || 0),
                    })
                })
            }
        }

        // Ensure data is sorted by timestamp and always increasing (cumulative)
        if (data.length > 0) {
            // Sort by revenue to ensure increasing trend
            data.sort((a, b) => {
                // Try to parse time to sort chronologically, fallback to revenue
                const timeA = dayjs(a.time, ['MM/DD', 'MM/DD HH:mm', 'HH:mm'], true).valueOf()
                const timeB = dayjs(b.time, ['MM/DD', 'MM/DD HH:mm', 'HH:mm'], true).valueOf()
                if (!isNaN(timeA) && !isNaN(timeB)) {
                    return timeA - timeB
                }
                return a.revenue - b.revenue
            })

            // Ensure values are always increasing (cumulative revenue can't decrease)
            let maxRevenue = 0
            data = data.map((point) => {
                maxRevenue = Math.max(maxRevenue, point.revenue)
                return {
                    ...point,
                    revenue: maxRevenue
                }
            })

            // Add current cumulative revenue counter value as the last data point
            const lastDataPoint = data[data.length - 1]
            const now = Date.now()
            let timeLabel = ''
            if (timeRange === 'lifetime') {
                timeLabel = dayjs().format('MM/DD HH:mm')
            } else if (timeRange === 'today') {
                timeLabel = dayjs().format('HH:mm')
            } else {
                timeLabel = 'Now'
            }

            // Use cumulative revenue if available, ensuring it's always >= last point
            const finalRevenue = cumulativeRevenue > 0
                ? Math.max(cumulativeRevenue, lastDataPoint.revenue)
                : Math.max(currentRevenue, lastDataPoint.revenue)

            // Only add if it's different from the last point to avoid duplicates
            if (finalRevenue > lastDataPoint.revenue) {
                data.push({
                    time: timeLabel,
                    revenue: finalRevenue,
                })
            }
        }

        return data.length > 0 ? data : [{ time: '0', revenue: 0 }]
    }, [timeRange, portState, cumulativeRevenue, metrics?.totalRevenue])

    // Calculate milestones and current revenue
    const currentRevenue = cumulativeRevenue || metrics?.totalRevenue || portState.lifetimeRevenue || 463.50 // Use cumulative revenue counter value

    // Format milestone value for display
    const formatMilestone = (value: number): string => {
        if (value >= 1000000) {
            const millions = value / 1000000
            // If it's a whole number, don't show decimals (e.g., 1M not 1.0M)
            return millions % 1 === 0 ? `$${millions}M` : `$${millions.toFixed(1)}M`
        } else if (value >= 1000) {
            const thousands = value / 1000
            // If it's a whole number, don't show decimals (e.g., 100K not 100.0K)
            return thousands % 1 === 0 ? `$${thousands}K` : `$${thousands.toFixed(1)}K`
        }
        return `$${value}`
    }

    const milestones = useMemo(() => {
        const milestoneValues = [1, 10, 100, 1000, 10000, 100000, 1000000, 10000000]
        return milestoneValues.map((m) => ({
            value: m,
            achieved: m <= currentRevenue,
        }))
    }, [currentRevenue])

    return (
        <Box
            bg="gray.800"
            border="1px solid"
            borderColor="purple.500"
            borderRadius="md"
            p={6}
            position="relative"
            overflow="hidden"
            _before={{
                content: '""',
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundImage: `
                    repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(111, 255, 194, 0.03) 2px, rgba(111, 255, 194, 0.03) 4px),
                    repeating-linear-gradient(90deg, transparent, transparent 2px, rgba(111, 255, 194, 0.03) 2px, rgba(111, 255, 194, 0.03) 4px)
                `,
                pointerEvents: 'none',
            }}
        >
            <VStack spacing={4} align="stretch" position="relative" zIndex={1}>
                <HStack justify="space-between" align="center">
                    <HStack spacing={2}>
                        <Text
                            fontSize="sm"
                            color="gray.400"
                            fontFamily="mono"
                            textTransform="uppercase"
                            letterSpacing="wide"
                        >
                            Total Revenue Earned
                        </Text>
                        <ShareButton cardType="revenue" size="xs" />
                    </HStack>
                    <ButtonGroup size="sm" isAttached variant="outline">
                        <Button
                            onClick={() => setTimeRange('lifetime')}
                            isActive={timeRange === 'lifetime'}
                            colorScheme={timeRange === 'lifetime' ? 'cyan' : 'gray'}
                            _active={{ bg: 'cyan.500', color: 'white' }}
                        >
                            Lifetime
                        </Button>
                        <Button
                            onClick={() => setTimeRange('today')}
                            isActive={timeRange === 'today'}
                            colorScheme={timeRange === 'today' ? 'cyan' : 'gray'}
                            _active={{ bg: 'cyan.500', color: 'white' }}
                        >
                            Today
                        </Button>
                        <Button
                            onClick={() => setTimeRange('session')}
                            isActive={timeRange === 'session'}
                            colorScheme={timeRange === 'session' ? 'cyan' : 'gray'}
                            _active={{ bg: 'cyan.500', color: 'white' }}
                        >
                            Session
                        </Button>
                    </ButtonGroup>
                </HStack>

                <Box h="300px" w="100%">
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData}>
                            <defs>
                                <linearGradient id="revenueGradient" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0%" stopColor="#6FFFC2" stopOpacity={0.8} />
                                    <stop offset="100%" stopColor="#6FFFC2" stopOpacity={0.1} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(111, 255, 194, 0.1)" />
                            <XAxis
                                dataKey="time"
                                stroke="rgba(111, 255, 194, 0.5)"
                                style={{ fontSize: '12px' }}
                            />
                            <YAxis
                                stroke="rgba(111, 255, 194, 0.5)"
                                style={{ fontSize: '12px' }}
                                tickFormatter={(value) => `$${value.toFixed(2)}`}
                            />
                            <Tooltip
                                contentStyle={{
                                    backgroundColor: '#1a2330',
                                    border: '1px solid #6FFFC2',
                                    borderRadius: '4px',
                                    color: '#6FFFC2',
                                }}
                                formatter={(value: number) => [`$${value.toFixed(2)}`, 'Revenue']}
                            />
                            <Line
                                type="monotone"
                                dataKey="revenue"
                                stroke="#6FFFC2"
                                strokeWidth={2}
                                dot={{ fill: '#6FFFC2', r: 3 }}
                                activeDot={{ r: 5, fill: '#6FFFC2' }}
                            />
                        </LineChart>
                    </ResponsiveContainer>
                </Box>

                <HStack spacing={4} flexWrap="wrap">
                    <Text fontSize="lg" fontWeight="bold" color="cyan.400" fontFamily="mono">
                        ${currentRevenue.toFixed(2)}
                    </Text>
                    {milestones.length > 0 && (
                        <HStack spacing={2}>
                            <Text fontSize="xs" color="gray.500" fontFamily="mono">
                                Milestones:
                            </Text>
                            {milestones.map((milestone) => (
                                <Box
                                    key={milestone.value}
                                    px={2}
                                    py={1}
                                    bg={milestone.achieved ? "green.500" : "gray.600"}
                                    borderRadius="sm"
                                    fontSize="xs"
                                    fontFamily="mono"
                                    color={milestone.achieved ? "white" : "gray.400"}
                                    opacity={milestone.achieved ? 1 : 0.6}
                                >
                                    {formatMilestone(milestone.value)}
                                </Box>
                            ))}
                        </HStack>
                    )}
                </HStack>
            </VStack>
        </Box>
    )
}
