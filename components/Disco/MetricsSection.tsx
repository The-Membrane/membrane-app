import React, { useMemo, useState } from 'react'
import { Box, VStack, HStack, Text, Grid, GridItem, Menu, MenuButton, MenuList, MenuItem, Button } from '@chakra-ui/react'
import { ChevronDownIcon } from '@chakra-ui/icons'
import { lazyChart } from '@/components/ui/lazyChart'
import { useDailyTVL } from '@/hooks/useDiscoData'
import { shiftDigits } from '@/helpers/math'
import { mockDailyTVL } from './mockData'
import { LTVHistoryChart } from './LTVHistoryChart'

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

const getBucketKey = (timestamp: number, unit: TimeUnit): string => {
    const d = new Date(timestamp * 1000)
    const y = d.getFullYear()
    const m = d.getMonth()
    switch (unit) {
        case 'daily': return `${y}-${m}-${d.getDate()}`
        case 'weekly': {
            const day = new Date(d)
            day.setDate(d.getDate() - ((d.getDay() + 6) % 7))
            return `${day.getFullYear()}-W${String(Math.ceil(((day.getTime() - new Date(day.getFullYear(), 0, 1).getTime()) / 86400000 + 1) / 7)).padStart(2, '0')}`
        }
        case 'monthly': return `${y}-${String(m + 1).padStart(2, '0')}`
        case 'quarterly': return `${y}-Q${Math.floor(m / 3) + 1}`
        case 'yearly': return `${y}`
    }
}

interface SlotData {
    slot: number
    tvl: number
    apr?: string | null
    weight?: string
}

interface MetricsSectionProps {
    globalTotalDeposits: number
    globalTotalInsurance: number
    selectedSlotData?: SlotData | null
    ltvChartAsset?: string
    ltvChartAssetSymbol?: string
    ltvChartQueue?: any
}

const GlobalTVLChart = lazyChart<{ tvlChartData: any[] }>(
    ({ LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip: RechartsTooltip, ResponsiveContainer, Brush }) =>
        function GlobalTVLChart({ tvlChartData }) {
            return (
                <ResponsiveContainer width="100%" height={250}>
                    <LineChart data={tvlChartData}>
                        <XAxis
                            dataKey="date"
                            stroke={PRIMARY_PURPLE}
                            strokeOpacity={0.6}
                            tick={{ fill: 'white', fontFamily: 'mono', fontSize: '10px', letterSpacing: '2px', fontWeight: 700 }}
                            interval="preserveStartEnd"
                            tickFormatter={(value, index) => {
                                if (tvlChartData.length === 0) return value
                                const step = Math.max(1, Math.floor(tvlChartData.length / 5))
                                if (index === 0 || index === tvlChartData.length - 1 || index % step === 0) {
                                    return value
                                }
                                return ''
                            }}
                        />
                        <YAxis
                            stroke={PRIMARY_PURPLE}
                            strokeOpacity={0.6}
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
                                return [`${formattedValue} MBRN`, 'TVL']
                            }}
                            labelFormatter={(label) => label}
                        />
                        <Line type="monotone" dataKey="tvl" stroke="#46d39a" strokeWidth={2} dot={false} />
                        <Brush
                            dataKey="date"
                            height={40}
                            stroke={PRIMARY_PURPLE}
                            fill="rgba(10, 10, 10, 0.8)"
                            travellerWidth={10}
                            tickFormatter={() => ''}
                        >
                            <AreaChart data={tvlChartData}>
                                <Area
                                    type="monotone"
                                    dataKey="tvl"
                                    stroke="#46d39a"
                                    fill="#46d39a"
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

export const MetricsSection = React.memo<MetricsSectionProps>(({ globalTotalDeposits, globalTotalInsurance, selectedSlotData, ltvChartAsset, ltvChartAssetSymbol, ltvChartQueue }) => {
    const { data: dailyTVL } = useDailyTVL()
    const [timeUnit, setTimeUnit] = useState<TimeUnit>('daily')

    // Use mock data if real data is not available
    const useMockData = !dailyTVL || !dailyTVL.entries || dailyTVL.entries.length === 0
    // Memoized so the reference is stable across renders (prevents rawTvlData useMemo from
    // recomputing every render).
    const dailyTVLToUse = useMemo(
        () => (useMockData ? mockDailyTVL.entries : (dailyTVL?.entries || [])),
        [useMockData, dailyTVL]
    )

    // Raw daily TVL chart data
    const rawTvlData = useMemo<{ timestamp: number; tvl: number }[]>(() => {
        return dailyTVLToUse.map((entry: any) => {
            const value = shiftDigits(entry.tvl || '0', -6)
            return {
                timestamp: entry.timestamp,
                tvl: parseFloat(typeof value === 'object' ? value.toString() : String(value)),
            }
        })
    }, [dailyTVLToUse])

    // Aggregate by time unit
    const tvlChartData = useMemo(() => {
        if (rawTvlData.length === 0) return []
        if (timeUnit === 'daily') {
            return rawTvlData.map(d => {
                const date = new Date(d.timestamp * 1000)
                return {
                    ...d,
                    date: `${MONTHS[date.getMonth()]} '${String(date.getFullYear()).slice(2)}`,
                }
            })
        }

        const buckets = new Map<string, { timestamp: number; tvl: number }>()
        for (const entry of rawTvlData) {
            const key = getBucketKey(entry.timestamp, timeUnit)
            buckets.set(key, entry)
        }

        return Array.from(buckets.values()).map(d => {
            const date = new Date(d.timestamp * 1000)
            return {
                ...d,
                date: `${MONTHS[date.getMonth()]} '${String(date.getFullYear()).slice(2)}`,
            }
        })
    }, [rawTvlData, timeUnit])

    // Calculate section-specific metrics based on selectedSlotData
    const sectionMetrics = useMemo(() => {
        if (!selectedSlotData) {
            return {
                totalDeposits: 0,
                pendingClaims: 0,
                lifetimeRevenue: 0,
                totalInsurance: 0,
            }
        }

        const sectionDeposits = parseFloat(shiftDigits(selectedSlotData.tvl.toString(), -6).toString())
        const sectionPendingClaims = 0
        const sectionLifetimeRevenue = 0
        const sectionInsurance = sectionDeposits > 0 && globalTotalDeposits > 0
            ? (sectionDeposits / globalTotalDeposits) * globalTotalInsurance
            : 0

        return {
            totalDeposits: sectionDeposits,
            pendingClaims: sectionPendingClaims,
            lifetimeRevenue: sectionLifetimeRevenue,
            totalInsurance: sectionInsurance,
        }
    }, [selectedSlotData, globalTotalDeposits, globalTotalInsurance])

    return (
        <Box w="100%" maxW="1400px" mx="auto" p={8}>
            <Grid templateColumns={'1fr'} gap={6}>

                {/* LTV History Chart */}
                {ltvChartAsset && (
                    <GridItem>
                        <LTVHistoryChart
                            asset={ltvChartAsset}
                            assetSymbol={ltvChartAssetSymbol}
                            ltvQueue={ltvChartQueue}
                        />
                    </GridItem>
                )}

                {/* Extended Section Metrics */}
                <Box mt={8} mb={16}>
                    <Text
                        fontSize="2xl"
                        fontWeight="bold"
                        color="white"
                        fontFamily="mono"
                        letterSpacing="2px"
                        textTransform="uppercase"
                        mb={6}
                        justifySelf="center"
                    >
                        Extended Section Metrics
                    </Text>

                    <Grid templateColumns={{ base: '1fr', md: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' }}
                        justifySelf="center"
                        gap={6}
                        w="100%"
                    >
                        {/* Total Deposits */}
                        {/* <GridItem>
                        <Box
                            bg="rgba(10, 10, 10, 0.8)"
                            p={4}
                            borderRadius="md"
                            border="2px solid"
                            borderColor={PRIMARY_PURPLE}
                            position="relative"
                            boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
                        >
                            <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="1px" mb={2}>
                                Total Deposits
                            </Text>
                            <Text fontSize="3xl" fontWeight="bold" color={PRIMARY_PURPLE} fontFamily="mono" textShadow={`0 0 10px ${PRIMARY_PURPLE}`}>
                                {sectionMetrics.totalDeposits.toLocaleString(undefined, { maximumFractionDigits: 2 })} MBRN
                            </Text>
                        </Box>
                    </GridItem> */}

                        {/* Lifetime Revenue */}
                        <GridItem>
                            <Box
                                bg="rgba(10, 10, 10, 0.8)"
                                p={4}
                                borderRadius="md"
                                border="2px solid"
                                borderColor={PRIMARY_PURPLE}
                                position="relative"
                                boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
                            >
                                <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="1px" mb={2}>
                                    Lifetime Revenue
                                </Text>
                                <Text fontSize="3xl" fontWeight="bold" color="white" fontFamily="mono">
                                    {sectionMetrics.lifetimeRevenue.toLocaleString('en-US', { maximumFractionDigits: 2 })} CDT
                                </Text>
                            </Box>
                        </GridItem>

                        {/* Total Insurance */}
                        <GridItem>
                            <Box
                                bg="rgba(10, 10, 10, 0.8)"
                                p={4}
                                borderRadius="md"
                                border="2px solid"
                                borderColor={PRIMARY_PURPLE}
                                position="relative"
                                boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
                            >
                                <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="1px" mb={2}>
                                    Total Insurance
                                </Text>
                                <Text fontSize="3xl" fontWeight="bold" color="white" fontFamily="mono">
                                    {sectionMetrics.totalInsurance.toLocaleString('en-US', { maximumFractionDigits: 2 })} CDT
                                </Text>
                            </Box>
                        </GridItem>
                    </Grid>
                </Box>
                {/* Daily TVL History Chart - Global */}
                <GridItem>
                    <Box
                        bg="rgba(10, 10, 10, 0.8)"
                        p={4}
                        borderRadius="md"
                        border="2px solid"
                        borderColor={PRIMARY_PURPLE}
                        position="relative"
                        boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
                    >
                        <Box mb={2}>
                            <Text
                                fontSize="2xl"
                                fontWeight="bold"
                                color="white"
                                fontFamily="mono"
                                letterSpacing="2px"
                                textTransform="uppercase"
                            >
                                Global Disco Metrics
                            </Text>
                            <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="1px">
                                Daily MBRN TVL History
                            </Text>
                        </Box>
                        <Box mb={2} w={{ base: '120px', md: '15%' }} minW="100px">
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
                        <GlobalTVLChart tvlChartData={tvlChartData} />
                    </Box>
                </GridItem>

            </Grid>

        </Box>
    )
})

MetricsSection.displayName = 'MetricsSection'
