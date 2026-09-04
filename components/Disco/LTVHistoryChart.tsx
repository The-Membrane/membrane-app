import React, { useMemo, useState } from 'react'
import { Box, VStack, HStack, Text, Menu, MenuButton, MenuList, MenuItem, Button } from '@chakra-ui/react'
import { ChevronDownIcon } from '@chakra-ui/icons'
import { lazyChart } from '@/components/ui/lazyChart'
import { useDailyDeposits } from '@/hooks/useDiscoData'
import { mockDailyDeposits } from './mockData'
import { shiftDigits } from '@/helpers/math'
import { SEMANTIC_COLORS } from '@/config/semanticColors'

// Color constants
const PRIMARY_PURPLE = 'rgb(155, 220, 79)'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

type TimeUnit = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly'
const TIME_UNIT_LABELS: Record<TimeUnit, string> = {
    daily: 'Daily',
    weekly: 'Weekly',
    monthly: 'Monthly',
    quarterly: 'Quarterly',
    yearly: 'Yearly',
}

// Get bucket key for a timestamp based on time unit
const getBucketKey = (timestamp: number, unit: TimeUnit): string => {
    const d = new Date(timestamp * 1000)
    const y = d.getFullYear()
    const m = d.getMonth()
    switch (unit) {
        case 'daily': return `${y}-${m}-${d.getDate()}`
        case 'weekly': {
            // ISO week: group by Monday of the week
            const day = new Date(d)
            day.setDate(d.getDate() - ((d.getDay() + 6) % 7))
            return `${day.getFullYear()}-W${String(Math.ceil(((day.getTime() - new Date(day.getFullYear(), 0, 1).getTime()) / 86400000 + 1) / 7)).padStart(2, '0')}`
        }
        case 'monthly': return `${y}-${String(m + 1).padStart(2, '0')}`
        case 'quarterly': return `${y}-Q${Math.floor(m / 3) + 1}`
        case 'yearly': return `${y}`
    }
}

interface LTVHistoryChartProps {
    asset: string
    assetSymbol?: string
    ltvQueue?: any
}

const DepositHistoryChart = lazyChart<{ chartData: any[]; yMax: number }>(
    ({ LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip: RechartsTooltip, ResponsiveContainer, Brush }) =>
        function DepositHistoryChart({ chartData, yMax }) {
            return (
                <ResponsiveContainer width="100%" height={250}>
                    <LineChart data={chartData}>
                        <XAxis
                            dataKey="date"
                            stroke={PRIMARY_PURPLE}
                            strokeOpacity={0.6}
                            tick={{ fill: 'white', fontFamily: 'mono', fontSize: '10px', letterSpacing: '2px', fontWeight: 700 }}
                            interval="preserveStartEnd"
                            tickFormatter={(value, index) => {
                                if (chartData.length === 0) return value
                                // Show ~5 ticks evenly spaced
                                const step = Math.max(1, Math.floor(chartData.length / 5))
                                if (index === 0 || index === chartData.length - 1 || index % step === 0) {
                                    return value
                                }
                                return ''
                            }}
                        />
                        <YAxis
                            stroke={PRIMARY_PURPLE}
                            strokeOpacity={0.6}
                            domain={[0, yMax]}
                            tick={{ fill: 'white', fontFamily: 'mono', fontSize: '10px', letterSpacing: '2px', fontWeight: 700 }}
                            tickFormatter={(value: number) => {
                                if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
                                if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`
                                return value.toString()
                            }}
                        />
                        <RechartsTooltip
                            contentStyle={{
                                backgroundColor: 'rgba(10, 10, 10, 0.95)',
                                border: `2px solid ${PRIMARY_PURPLE}`,
                                borderRadius: '4px',
                                color: 'white',
                                fontFamily: 'mono',
                            }}
                            formatter={(value: any) => {
                                const formattedValue = typeof value === 'number'
                                    ? value.toLocaleString(undefined, { maximumFractionDigits: 0 })
                                    : parseFloat(value || '0').toLocaleString(undefined, { maximumFractionDigits: 0 })
                                return [`${formattedValue} MBRN`, 'Deposits']
                            }}
                            labelFormatter={(label) => `Date: ${label}`}
                        />
                        <Line
                            type="monotone"
                            dataKey="deposits"
                            stroke={SEMANTIC_COLORS.secondary}
                            strokeWidth={2}
                            name="Deposits"
                            dot={false}
                            activeDot={{ r: 5 }}
                        />
                        <Brush
                            dataKey="date"
                            height={40}
                            stroke={PRIMARY_PURPLE}
                            fill="rgba(10, 10, 10, 0.8)"
                            travellerWidth={10}
                            tickFormatter={() => ''}
                        >
                            <AreaChart data={chartData}>
                                <Area
                                    type="monotone"
                                    dataKey="deposits"
                                    stroke={SEMANTIC_COLORS.secondary}
                                    fill={SEMANTIC_COLORS.secondary}
                                    fillOpacity={0.2}
                                    strokeWidth={1}
                                />
                            </AreaChart>
                        </Brush>
                    </LineChart>
                </ResponsiveContainer>
            )
        },
    250,
)

export const LTVHistoryChart: React.FC<LTVHistoryChartProps> = ({ asset, assetSymbol }) => {
    const { data: dailyDeposits, isLoading } = useDailyDeposits(asset)
    const [timeUnit, setTimeUnit] = useState<TimeUnit>('daily')

    // Use mock data if real data is not available
    const useMockData = !dailyDeposits || !dailyDeposits.entries || dailyDeposits.entries.length === 0
    // Memoized so the reference is stable across renders (prevents rawChartData useMemo from
    // recomputing every render).
    const dailyDepositsToUse = useMemo(
        () => (useMockData ? mockDailyDeposits.entries : (dailyDeposits?.entries || [])),
        [useMockData, dailyDeposits]
    )

    // Process raw chart data
    const rawChartData = useMemo<{ timestamp: number; deposits: number }[]>(() => {
        if (!dailyDepositsToUse || dailyDepositsToUse.length === 0) return []

        return dailyDepositsToUse.map((entry: any) => {
            const depositTokens = parseFloat(shiftDigits(entry.deposit_tokens || '0', -6).toString())
            return {
                timestamp: entry.timestamp,
                deposits: depositTokens,
            }
        })
    }, [dailyDepositsToUse])

    // Aggregate by time unit
    const chartData = useMemo(() => {
        if (rawChartData.length === 0) return []
        if (timeUnit === 'daily') {
            return rawChartData.map(d => {
                const date = new Date(d.timestamp * 1000)
                return {
                    ...d,
                    date: `${MONTHS[date.getMonth()]} '${String(date.getFullYear()).slice(2)}`,
                }
            })
        }

        const buckets = new Map<string, { timestamp: number; deposits: number }>()
        for (const entry of rawChartData) {
            const key = getBucketKey(entry.timestamp, timeUnit)
            buckets.set(key, entry) // last entry wins (point-in-time snapshot)
        }

        return Array.from(buckets.values()).map(d => {
            const date = new Date(d.timestamp * 1000)
            return {
                ...d,
                date: `${MONTHS[date.getMonth()]} '${String(date.getFullYear()).slice(2)}`,
            }
        })
    }, [rawChartData, timeUnit])

    // Y-axis max with 20% buffer
    const yMax = useMemo(() => {
        if (chartData.length === 0) return 0
        const max = Math.max(...chartData.map((d: any) => d.deposits))
        return Math.ceil(max * 1.2)
    }, [chartData])

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
                    Loading Deposit History...
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
                    No deposit history available
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
                <Box>
                    <Text
                        fontSize="xl"
                        fontWeight="bold"
                        color="white"
                        fontFamily="mono"
                        letterSpacing="2px"
                        textTransform="uppercase"
                    >
                        {assetSymbol || asset} Deposit History
                    </Text>
                    <Text fontSize="sm" color="whiteAlpha.600" fontFamily="mono" mt={-1}>
                        Historical daily MBRN deposits for {assetSymbol || asset}
                    </Text>
                </Box>
                <Box mt={2} w={{ base: '120px', md: '15%' }} minW="100px">
                    <Menu>
                        <MenuButton
                            as={Button}
                            w="100%"
                            size="xs"
                            variant="outline"
                            borderColor={`${PRIMARY_PURPLE}60`}
                            color="whiteAlpha.800"
                            fontFamily="mono"
                            fontSize="xs"
                            rightIcon={<ChevronDownIcon />}
                            _hover={{ borderColor: PRIMARY_PURPLE, color: 'white' }}
                            _active={{ bg: `${PRIMARY_PURPLE}20` }}
                        >
                            {TIME_UNIT_LABELS[timeUnit]}
                        </MenuButton>
                        <MenuList
                            bg="rgba(10, 10, 10, 0.95)"
                            borderColor={PRIMARY_PURPLE}
                            minW="120px"
                        >
                            {(Object.keys(TIME_UNIT_LABELS) as TimeUnit[]).map(unit => (
                                <MenuItem
                                    key={unit}
                                    onClick={() => setTimeUnit(unit)}
                                    bg={timeUnit === unit ? `${PRIMARY_PURPLE}20` : 'transparent'}
                                    color={timeUnit === unit ? PRIMARY_PURPLE : 'whiteAlpha.800'}
                                    fontFamily="mono"
                                    fontSize="xs"
                                    _hover={{ bg: `${PRIMARY_PURPLE}15`, color: 'white' }}
                                >
                                    {TIME_UNIT_LABELS[unit]}
                                </MenuItem>
                            ))}
                        </MenuList>
                    </Menu>
                </Box>
                <DepositHistoryChart chartData={chartData} yMax={yMax} />
            </VStack>
        </Box>
    )
}
