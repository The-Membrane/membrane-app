import React from 'react'
import { Box, VStack, Text, Grid, GridItem } from '@chakra-ui/react'
import {
    LineChart,
    Line,
    AreaChart,
    Area,
    BarChart,
    Bar,
    PieChart,
    Pie,
    Cell,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip as RechartsTooltip,
    Legend,
    ResponsiveContainer,
} from 'recharts'
import { useDiscoUserMetrics } from '@/hooks/useDiscoData'
import { useDailyTVL } from '@/hooks/useDiscoData'
import { getDiscoTotalInsurance } from '@/services/flywheel'
import { useQuery } from '@tanstack/react-query'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import { shiftDigits } from '@/helpers/math'

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#82ca9d']

export const MetricsSection = React.memo(() => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)
    const { deposits, pendingClaims, lifetimeRevenue, dailyTVL } = useDiscoUserMetrics(undefined)
    const { data: totalInsurance } = useQuery({
        queryKey: ['disco', 'total_insurance', appState.rpcUrl],
        queryFn: () => getDiscoTotalInsurance(client || null),
        enabled: !!client,
        staleTime: 1000 * 60 * 5,
    })

    // Prepare data for charts
    const totalDeposits = deposits?.reduce((sum: number, d: any) => {
        const value = shiftDigits(d.vault_tokens || '0', -6)
        return sum + parseFloat(typeof value === 'object' ? value.toString() : String(value))
    }, 0) || 0

    const pendingClaimsTotal = pendingClaims?.reduce((sum: number, claim: any) => {
        const value = shiftDigits(claim.pending_amount || '0', -6)
        return sum + parseFloat(typeof value === 'object' ? value.toString() : String(value))
    }, 0) || 0

    const lifetimeRevenueTotal = lifetimeRevenue?.reduce((sum: number, entry: any) => {
        const value = shiftDigits(entry.total_revenue || '0', -6)
        return sum + parseFloat(typeof value === 'object' ? value.toString() : String(value))
    }, 0) || 0

    // Daily TVL chart data
    const tvlChartData = dailyTVL?.map((entry: any) => {
        const value = shiftDigits(entry.tvl || '0', -6)
        return {
            date: new Date(entry.timestamp * 1000).toLocaleDateString(),
            tvl: parseFloat(typeof value === 'object' ? value.toString() : String(value)),
        }
    }) || []

    // Deposit distribution by LTV
    const depositDistribution = deposits?.reduce((acc: any, deposit: any) => {
        const ltv = deposit.ltv || deposit.max_ltv || '0'
        const ltvNum = typeof ltv === 'object' ? parseFloat(ltv.toString()) : parseFloat(String(ltv))
        const key = `${Math.floor(ltvNum / 10) * 10}-${Math.floor(ltvNum / 10) * 10 + 10}`
        if (!acc[key]) {
            acc[key] = 0
        }
        const value = shiftDigits(deposit.vault_tokens || '0', -6)
        acc[key] += parseFloat(typeof value === 'object' ? value.toString() : String(value))
        return acc
    }, {})

    const depositDistributionData = Object.entries(depositDistribution || {}).map(([name, value]) => ({
        name,
        value,
    }))

    // Lock status breakdown
    const lockedCount = deposits?.filter((d: any) =>
        d.locked && d.locked.locked_until > Math.floor(Date.now() / 1000)
    ).length || 0
    const unlockedCount = (deposits?.length || 0) - lockedCount

    const lockStatusData = [
        { name: 'Locked', value: lockedCount },
        { name: 'Unlocked', value: unlockedCount },
    ]

    return (
        <Box w="100%" maxW="1400px" mx="auto" p={8}>
            <Text
                variant="title"
                fontSize="2xl"
                fontWeight="bold"
                mb={6}
            >
                Disco Metrics
            </Text>

            <Grid templateColumns={{ base: '1fr', md: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' }} gap={6}>
                {/* Total Deposits */}
                <GridItem>
                    <Box bg="whiteAlpha.50" p={4} borderRadius="md" border="1px solid" borderColor="whiteAlpha.200">
                        <Text fontSize="lg" fontWeight="bold" mb={4}>Total Deposits</Text>
                        <Text fontSize="3xl" fontWeight="bold">{totalDeposits.toLocaleString()} MBRN</Text>
                    </Box>
                </GridItem>

                {/* Pending Claims */}
                <GridItem>
                    <Box bg="whiteAlpha.50" p={4} borderRadius="md" border="1px solid" borderColor="whiteAlpha.200">
                        <Text fontSize="lg" fontWeight="bold" mb={4}>Pending Claims</Text>
                        <Text fontSize="3xl" fontWeight="bold">{pendingClaimsTotal.toLocaleString()} CDT</Text>
                    </Box>
                </GridItem>

                {/* Lifetime Revenue */}
                <GridItem>
                    <Box bg="whiteAlpha.50" p={4} borderRadius="md" border="1px solid" borderColor="whiteAlpha.200">
                        <Text fontSize="lg" fontWeight="bold" mb={4}>Lifetime Revenue</Text>
                        <Text fontSize="3xl" fontWeight="bold">{lifetimeRevenueTotal.toLocaleString()} CDT</Text>
                    </Box>
                </GridItem>

                {/* Total Insurance */}
                <GridItem>
                    <Box bg="whiteAlpha.50" p={4} borderRadius="md" border="1px solid" borderColor="whiteAlpha.200">
                        <Text fontSize="lg" fontWeight="bold" mb={4}>Total Insurance</Text>
                        <Text fontSize="3xl" fontWeight="bold">
                            {totalInsurance ? parseFloat(shiftDigits(totalInsurance, -6)).toLocaleString() : '0'} CDT
                        </Text>
                    </Box>
                </GridItem>

                {/* Daily TVL History Chart */}
                <GridItem colSpan={{ base: 1, md: 2 }}>
                    <Box bg="whiteAlpha.50" p={4} borderRadius="md" border="1px solid" borderColor="whiteAlpha.200">
                        <Text fontSize="lg" fontWeight="bold" mb={4}>Daily TVL History</Text>
                        <ResponsiveContainer width="100%" height={200}>
                            <LineChart data={tvlChartData}>
                                <CartesianGrid strokeDasharray="3 3" stroke="whiteAlpha.200" />
                                <XAxis dataKey="date" stroke="whiteAlpha.600" />
                                <YAxis stroke="whiteAlpha.600" />
                                <RechartsTooltip contentStyle={{ backgroundColor: 'rgba(0,0,0,0.8)', border: 'none' }} />
                                <Line type="monotone" dataKey="tvl" stroke="#3182ce" strokeWidth={2} />
                            </LineChart>
                        </ResponsiveContainer>
                    </Box>
                </GridItem>

                {/* Deposit Distribution by LTV */}
                <GridItem>
                    <Box bg="whiteAlpha.50" p={4} borderRadius="md" border="1px solid" borderColor="whiteAlpha.200">
                        <Text fontSize="lg" fontWeight="bold" mb={4}>Deposit Distribution by LTV</Text>
                        <ResponsiveContainer width="100%" height={200}>
                            <PieChart>
                                <Pie
                                    data={depositDistributionData}
                                    cx="50%"
                                    cy="50%"
                                    labelLine={false}
                                    label={({ name, percent }) => `${name}%: ${(percent * 100).toFixed(0)}%`}
                                    outerRadius={80}
                                    fill="#8884d8"
                                    dataKey="value"
                                >
                                    {depositDistributionData.map((entry, index) => (
                                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                                    ))}
                                </Pie>
                                <RechartsTooltip />
                            </PieChart>
                        </ResponsiveContainer>
                    </Box>
                </GridItem>

                {/* Lock Status Breakdown */}
                <GridItem>
                    <Box bg="whiteAlpha.50" p={4} borderRadius="md" border="1px solid" borderColor="whiteAlpha.200">
                        <Text fontSize="lg" fontWeight="bold" mb={4}>Lock Status Breakdown</Text>
                        <ResponsiveContainer width="100%" height={200}>
                            <BarChart data={lockStatusData}>
                                <CartesianGrid strokeDasharray="3 3" stroke="whiteAlpha.200" />
                                <XAxis dataKey="name" stroke="whiteAlpha.600" />
                                <YAxis stroke="whiteAlpha.600" />
                                <RechartsTooltip contentStyle={{ backgroundColor: 'rgba(0,0,0,0.8)', border: 'none' }} />
                                <Bar dataKey="value" fill="#3182ce" />
                            </BarChart>
                        </ResponsiveContainer>
                    </Box>
                </GridItem>
            </Grid>
        </Box>
    )
})

MetricsSection.displayName = 'MetricsSection'

