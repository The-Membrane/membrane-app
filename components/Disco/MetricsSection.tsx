import React, { useMemo } from 'react'
import { Box, VStack, Text, Grid, GridItem } from '@chakra-ui/react'
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    Tooltip as RechartsTooltip,
    ResponsiveContainer,
} from 'recharts'
import { useDailyTVL } from '@/hooks/useDiscoData'
import { shiftDigits } from '@/helpers/math'
import { mockDailyTVL } from './mockData'
import { LTVHistoryChart } from './LTVHistoryChart'

interface IndividualLTVData {
    ltv: number
    borrowLTV?: number
    tvl: number
    apr?: string | null
    slotData?: any
}

interface MetricsSectionProps {
    globalTotalDeposits: number
    globalTotalInsurance: number
    selectedLTVData?: IndividualLTVData | null
    ltvChartAsset?: string
    ltvChartAssetSymbol?: string
    ltvChartQueue?: any
}

export const MetricsSection = React.memo<MetricsSectionProps>(({ globalTotalDeposits, globalTotalInsurance, selectedLTVData, ltvChartAsset, ltvChartAssetSymbol, ltvChartQueue }) => {
    const { data: dailyTVL } = useDailyTVL()

    // Use mock data if real data is not available
    const useMockData = !dailyTVL || !dailyTVL.entries || dailyTVL.entries.length === 0
    const dailyTVLToUse = useMockData ? mockDailyTVL.entries : (dailyTVL?.entries || [])

    // Daily TVL chart data (already global)
    const tvlChartData = dailyTVLToUse.map((entry: any) => {
        const value = shiftDigits(entry.tvl || '0', -6)
        return {
            date: new Date(entry.timestamp * 1000).toLocaleDateString(),
            timestamp: entry.timestamp,
            tvl: parseFloat(typeof value === 'object' ? value.toString() : String(value)),
        }
    })

    // Calculate section-specific metrics based on selectedLTVData
    const sectionMetrics = useMemo(() => {
        if (!selectedLTVData) {
            return {
                totalDeposits: 0,
                pendingClaims: 0,
                lifetimeRevenue: 0,
                totalInsurance: 0,
            }
        }

        // Section-specific deposits (convert from base units to MBRN)
        const sectionDeposits = parseFloat(shiftDigits(selectedLTVData.tvl.toString(), -6).toString())

        // Section-specific pending claims (placeholder - would need actual section-specific query)
        const sectionPendingClaims = 0 // TODO: Query section-specific pending claims

        // Section-specific lifetime revenue (placeholder - would need actual section-specific query)
        const sectionLifetimeRevenue = 0 // TODO: Query section-specific lifetime revenue

        // Section-specific insurance (proportional to deposits or placeholder)
        const sectionInsurance = sectionDeposits > 0 && globalTotalDeposits > 0
            ? (sectionDeposits / globalTotalDeposits) * globalTotalInsurance
            : 0

        return {
            totalDeposits: sectionDeposits,
            pendingClaims: sectionPendingClaims,
            lifetimeRevenue: sectionLifetimeRevenue,
            totalInsurance: sectionInsurance,
        }
    }, [selectedLTVData, globalTotalDeposits, globalTotalInsurance])

    // Color constants
    const PRIMARY_PURPLE = 'rgb(166, 146, 255)'
    const DARK_BG = '#0A0A0A'

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
                        color={PRIMARY_PURPLE}
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

                        {/* Pending Claims */}
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
                                    Pending Claims
                                </Text>
                                <Text fontSize="3xl" fontWeight="bold" color={PRIMARY_PURPLE} fontFamily="mono" textShadow={`0 0 10px ${PRIMARY_PURPLE}`}>
                                    {sectionMetrics.pendingClaims.toLocaleString()} CDT
                                </Text>
                            </Box>
                        </GridItem>

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
                                <Text fontSize="3xl" fontWeight="bold" color={PRIMARY_PURPLE} fontFamily="mono" textShadow={`0 0 10px ${PRIMARY_PURPLE}`}>
                                    {sectionMetrics.lifetimeRevenue.toLocaleString(undefined, { maximumFractionDigits: 2 })} CDT
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
                                <Text fontSize="3xl" fontWeight="bold" color={PRIMARY_PURPLE} fontFamily="mono" textShadow={`0 0 10px ${PRIMARY_PURPLE}`}>
                                    {sectionMetrics.totalInsurance.toLocaleString(undefined, { maximumFractionDigits: 2 })} CDT
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
                        <Text
                            fontSize="2xl"
                            fontWeight="bold"
                            color={PRIMARY_PURPLE}
                            fontFamily="mono"
                            letterSpacing="2px"
                            textTransform="uppercase"
                            mb={2}
                        >
                            Global Disco Metrics
                        </Text>
                        <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="1px" mb={4}>
                            Daily TVL History
                        </Text>
                        <ResponsiveContainer width="100%" height={200}>
                            <LineChart data={tvlChartData}>
                                <XAxis
                                    dataKey="date"
                                    stroke={PRIMARY_PURPLE}
                                    strokeOpacity={0.6}
                                    tick={{ fill: PRIMARY_PURPLE, fontFamily: 'mono', fontSize: '10px' }}
                                    interval="preserveStartEnd"
                                    tickFormatter={(value, index) => {
                                        // Show only weekly dates (every 7 days)
                                        if (tvlChartData.length === 0) return value
                                        const entry = tvlChartData[index]
                                        if (!entry || !entry.timestamp) return value

                                        // Get the first entry's timestamp as reference
                                        const firstTimestamp = tvlChartData[0]?.timestamp || 0
                                        const daysSinceStart = Math.floor((entry.timestamp - firstTimestamp) / 86400)

                                        // Show date if it's a multiple of 7 days, or if it's the first/last entry
                                        if (daysSinceStart % 7 === 0 || index === 0 || index === tvlChartData.length - 1) {
                                            return value
                                        }
                                        return ''
                                    }}
                                />
                                <YAxis
                                    stroke={PRIMARY_PURPLE}
                                    strokeOpacity={0.6}
                                    tick={{ fill: PRIMARY_PURPLE, fontFamily: 'mono', fontSize: '10px' }}
                                    label={{ value: 'MBRN', angle: -90, position: 'insideLeft', fill: PRIMARY_PURPLE, fontFamily: 'mono', fontSize: '12px', fontWeight: '700' }}
                                />
                                <RechartsTooltip
                                    contentStyle={{
                                        backgroundColor: 'rgba(10, 10, 10, 0.95)',
                                        border: `2px solid ${PRIMARY_PURPLE}`,
                                        borderRadius: '4px',
                                        color: PRIMARY_PURPLE,
                                        fontFamily: 'mono',
                                    }}
                                    formatter={(value: any) => {
                                        const formattedValue = typeof value === 'number'
                                            ? value.toFixed(2)
                                            : parseFloat(value || '0').toFixed(2)
                                        return [`${formattedValue} MBRN`, 'TVL']
                                    }}
                                    labelFormatter={(label) => label}
                                />
                                <Line type="monotone" dataKey="tvl" stroke={PRIMARY_PURPLE} strokeWidth={2} dot={false} />
                            </LineChart>
                        </ResponsiveContainer>
                    </Box>
                </GridItem>

            </Grid>

        </Box>
    )
})

MetricsSection.displayName = 'MetricsSection'

