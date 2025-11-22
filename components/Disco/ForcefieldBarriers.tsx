import React, { useMemo } from 'react'
import { Box, Text } from '@chakra-ui/react'
import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip as RechartsTooltip,
    ResponsiveContainer,
    Cell,
} from 'recharts'
import { getLTVRange, getUserDepositsInLayer, calculateLayerTVL } from './utils'

// Mock TVL data for each LTV layer (in MBRN, 6 decimals)
const mockLayerTVL: Record<number, number> = {
    0: 1250000,  // 60-63%: 1.25M MBRN
    1: 2100000,  // 63-66%: 2.1M MBRN
    2: 3500000,  // 66-69%: 3.5M MBRN
    3: 4800000,  // 69-72%: 4.8M MBRN
    4: 6200000,  // 72-75%: 6.2M MBRN
    5: 7500000,  // 75-78%: 7.5M MBRN
    6: 8900000,  // 78-81%: 8.9M MBRN
    7: 10200000, // 81-84%: 10.2M MBRN
    8: 11500000, // 84-87%: 11.5M MBRN
    9: 12800000, // 87-90%: 12.8M MBRN
}

interface ForcefieldBarriersProps {
    ltvQueues?: any[]
    userDeposits?: any[]
}

// Custom tooltip for the bar chart
const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
        const data = payload[0].payload
        return (
            <Box
                bg="black"
                p={4}
                borderRadius="md"
                border="1px solid"
                borderColor="whiteAlpha.300"
                minW="200px"
            >
                <Text fontWeight="bold" mb={2}>
                    LTV Range: {data.range}
                </Text>
                <Text fontSize="sm" color="whiteAlpha.700" mb={1}>
                    TVL: {data.tvl.toLocaleString()} MBRN
                </Text>
                {data.userDeposits && data.userDeposits.length > 0 && (
                    <>
                        <Text fontWeight="bold" mt={2} mb={1}>
                            Your Deposits:
                        </Text>
                        {data.userDeposits.map((deposit: any, idx: number) => {
                            const ltv = deposit.ltv || deposit.max_ltv || '0'
                            const maxBorrow = deposit.max_borrow_ltv || '0'
                            const ltvStr = typeof ltv === 'object' ? (ltv?.toString?.() || String(ltv)) : String(ltv)
                            const maxBorrowStr = typeof maxBorrow === 'object' ? (maxBorrow?.toString?.() || String(maxBorrow)) : String(maxBorrow)
                            return (
                                <Text key={idx} fontSize="xs" color="whiteAlpha.600">
                                    LTV: {ltvStr}, Max Borrow: {maxBorrowStr}
                                </Text>
                            )
                        })}
                    </>
                )}
            </Box>
        )
    }
    return null
}

export const ForcefieldBarriers = React.memo(({ ltvQueues, userDeposits = [] }: ForcefieldBarriersProps) => {
    const layers = Array.from({ length: 10 }, (_, i) => i)

    const hasUserDeposits = (layer: number) => {
        return getUserDepositsInLayer(userDeposits, layer).length > 0
    }

    const getLayerTVL = (layer: number) => {
        // Try to get real TVL from queues
        let hasRealData = false
        if (ltvQueues && ltvQueues.length > 0) {
            let total = 0
            ltvQueues.forEach((queue: any) => {
                if (queue?.queue && queue.queue.slots && queue.queue.slots.length > 0) {
                    const tvl = parseFloat(calculateLayerTVL(queue.queue, layer))
                    if (!isNaN(tvl) && tvl > 0) {
                        total += tvl
                        hasRealData = true
                    }
                }
            })
            // Only return real data if we have meaningful values
            if (hasRealData && total > 0) {
                return total
            }
        }
        // Always fall back to mock data if no real data
        const mockValue = mockLayerTVL[layer] || 0
        return mockValue
    }

    // Prepare chart data - ordered from highest to lowest (layer 9 to layer 0)
    const chartData = useMemo(() => {
        const data = layers.map((layer) => {
            const { min, max } = getLTVRange(layer)
            const tvl = getLayerTVL(layer)
            const userDepositsInLayer = getUserDepositsInLayer(userDeposits, layer)
            const hasDeposits = userDepositsInLayer.length > 0

            const tvlValue = Number(tvl) || 0

            return {
                layer,
                range: `${min}-${max}%`,
                tvl: tvlValue,
                hasDeposits,
                userDeposits: userDepositsInLayer,
            }
        }).reverse() // Reverse to show highest (layer 9) at top, lowest (layer 0) at bottom

        // Debug: verify all data points have values
        console.log('ForcefieldBarriers chartData:', data.map(d => ({ range: d.range, tvl: d.tvl })))

        return data
    }, [ltvQueues, userDeposits, layers])

    return (
        <Box
            w="100%"
            maxW="1000px"
            mx="auto"
            mb={8}
        >
            <ResponsiveContainer width="100%" height={400}>
                <BarChart
                    data={chartData}
                    layout="vertical"
                    margin={{ top: 20, right: 30, left: 80, bottom: 20 }}
                >
                    <CartesianGrid strokeDasharray="3 3" stroke="whiteAlpha.200" />
                    <XAxis
                        type="number"
                        hide
                        domain={[0, 'dataMax']}
                    />
                    <YAxis
                        type="category"
                        dataKey="range"
                        stroke="whiteAlpha.600"
                        tick={{ fill: 'rgba(255, 255, 255, 0.6)' }}
                        width={70}
                    />
                    <RechartsTooltip content={<CustomTooltip />} />
                    <Bar dataKey="tvl" radius={[0, 4, 4, 0]} minPointSize={1}>
                        {chartData.map((entry, index) => (
                            <Cell
                                key={`cell-${index}`}
                                fill={entry.hasDeposits ? '#60A5FA' : 'rgba(255, 255, 255, 0.2)'}
                            />
                        ))}
                    </Bar>
                </BarChart>
            </ResponsiveContainer>
        </Box>
    )
})

ForcefieldBarriers.displayName = 'ForcefieldBarriers'
