import React, { useMemo, useState } from 'react'
import { Box, Text, HStack, VStack, Button } from '@chakra-ui/react'
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
import { shiftDigits } from '@/helpers/math'

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
    allDeposits?: any[] // All deposits for calculating lock status
}

// Lock ceiling: 1 year in seconds
const LOCK_CEILING_SECONDS = 365 * 24 * 60 * 60 // 31536000 seconds

// Calculate lock distribution percentages for a layer
const calculateLockDistribution = (segments: Array<{ tvl: number; opacity: number; isLocked: boolean }>, totalTVL: number) => {
    if (!segments || segments.length === 0 || totalTVL === 0) {
        return { '1M': 0, '3M': 0, '6M': 0, '12M': 0 }
    }

    // Lock durations in seconds
    const ONE_MONTH = 30 * 86400
    const THREE_MONTHS = 90 * 86400
    const SIX_MONTHS = 180 * 86400
    const TWELVE_MONTHS = 365 * 86400

    let locked1MPlus = 0
    let locked3MPlus = 0
    let locked6MPlus = 0
    let locked12MPlus = 0

    segments.forEach(segment => {
        if (segment.isLocked && segment.opacity > 0) {
            // Convert opacity back to seconds remaining
            const secondsRemaining = segment.opacity * LOCK_CEILING_SECONDS

            if (secondsRemaining >= ONE_MONTH) {
                locked1MPlus += segment.tvl
            }
            if (secondsRemaining >= THREE_MONTHS) {
                locked3MPlus += segment.tvl
            }
            if (secondsRemaining >= SIX_MONTHS) {
                locked6MPlus += segment.tvl
            }
            if (secondsRemaining >= TWELVE_MONTHS) {
                locked12MPlus += segment.tvl
            }
        }
    })

    return {
        '1M': totalTVL > 0 ? (locked1MPlus / totalTVL) * 100 : 0,
        '3M': totalTVL > 0 ? (locked3MPlus / totalTVL) * 100 : 0,
        '6M': totalTVL > 0 ? (locked6MPlus / totalTVL) * 100 : 0,
        '12M': totalTVL > 0 ? (locked12MPlus / totalTVL) * 100 : 0,
    }
}

// Custom tooltip for the bar chart
const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
        const data = payload[0].payload
        const { segments = [], tvl = 0 } = data
        const distribution = calculateLockDistribution(segments, tvl)

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
                <Text fontSize="sm" color="whiteAlpha.700" mb={3}>
                    TVL: {data.tvl.toLocaleString()} MBRN
                </Text>
                <Text fontWeight="bold" mb={2}>
                    Lock Distribution:
                </Text>
                <VStack spacing={1} align="stretch">
                    <HStack justify="space-between">
                        <Text fontSize="sm" color="whiteAlpha.600">1M+</Text>
                        <Text fontSize="sm" color="whiteAlpha.800" fontWeight="bold">
                            {distribution['1M'].toFixed(1)}%
                        </Text>
                    </HStack>
                    <HStack justify="space-between">
                        <Text fontSize="sm" color="whiteAlpha.600">3M+</Text>
                        <Text fontSize="sm" color="whiteAlpha.800" fontWeight="bold">
                            {distribution['3M'].toFixed(1)}%
                        </Text>
                    </HStack>
                    <HStack justify="space-between">
                        <Text fontSize="sm" color="whiteAlpha.600">6M+</Text>
                        <Text fontSize="sm" color="whiteAlpha.800" fontWeight="bold">
                            {distribution['6M'].toFixed(1)}%
                        </Text>
                    </HStack>
                    <HStack justify="space-between">
                        <Text fontSize="sm" color="whiteAlpha.600">12M+</Text>
                        <Text fontSize="sm" color="whiteAlpha.800" fontWeight="bold">
                            {distribution['12M'].toFixed(1)}%
                        </Text>
                    </HStack>
                </VStack>
            </Box>
        )
    }
    return null
}

export const ForcefieldBarriers = React.memo(({ ltvQueues, userDeposits = [], allDeposits = [] }: ForcefieldBarriersProps) => {
    const [ltvMode, setLtvMode] = useState<'max_ltv' | 'max_borrow_ltv'>('max_ltv')
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

    // Get deposits in layer based on selected LTV mode
    const getDepositsInLayer = (deposits: any[], layer: number) => {
        const { min, max } = getLTVRange(layer)
        return deposits.filter(deposit => {
            const ltvRaw = ltvMode === 'max_ltv'
                ? (deposit.ltv || deposit.max_ltv || '0')
                : (deposit.max_borrow_ltv || '0')
            // Convert to percentage if it's a decimal (0.61 -> 61)
            const ltvNum = parseFloat(ltvRaw)
            const ltv = ltvNum < 1 ? ltvNum * 100 : ltvNum
            return ltv >= min && ltv < max
        })
    }

    // Calculate lock opacity based on lock duration vs lock_ceiling
    const calculateLockOpacity = (locked: any): number => {
        if (!locked || !locked.locked_until) return 0

        const now = Math.floor(Date.now() / 1000)
        const lockedUntil = parseInt(locked.locked_until || '0')

        if (lockedUntil <= now) return 0

        const secondsRemaining = lockedUntil - now
        // Opacity is based on how close to lock_ceiling (1 year)
        // If locked for 9 months (75% of 1 year), opacity is 0.75
        const opacity = Math.min(1, secondsRemaining / LOCK_CEILING_SECONDS)
        return opacity
    }

    // Calculate segments for each deposit in a layer
    // Each deposit gets its own segment with its own opacity
    const calculateLayerLockData = (layer: number, totalTVL: number) => {
        const depositsInLayer = getDepositsInLayer(allDeposits.length > 0 ? allDeposits : userDeposits, layer)

        if (depositsInLayer.length === 0 || totalTVL === 0) {
            return { segments: [{ tvl: totalTVL, opacity: 0, isLocked: false }] }
        }

        const segments: Array<{ tvl: number; opacity: number; isLocked: boolean }> = []

        depositsInLayer.forEach((deposit: any) => {
            const vaultTokens = shiftDigits(deposit.vault_tokens || '0', -6)
            const tvlValue = parseFloat(typeof vaultTokens === 'object' ? vaultTokens.toString() : String(vaultTokens))

            if (deposit.locked && deposit.locked.locked_until > Math.floor(Date.now() / 1000)) {
                const opacity = calculateLockOpacity(deposit.locked)
                segments.push({ tvl: tvlValue, opacity, isLocked: true })
            } else {
                segments.push({ tvl: tvlValue, opacity: 0, isLocked: false })
            }
        })

        // Calculate total deposit TVL in this layer
        const totalDepositTVL = segments.reduce((sum, seg) => sum + seg.tvl, 0)

        // If we have deposit data, scale each segment to match total TVL proportionally
        // Otherwise, create a single unlocked segment for the full TVL
        if (totalDepositTVL > 0 && totalDepositTVL > 0) {
            const scaleFactor = totalTVL / totalDepositTVL
            return {
                segments: segments.map(seg => ({
                    ...seg,
                    tvl: seg.tvl * scaleFactor
                }))
            }
        }

        // If no deposits match, show full bar as unlocked
        return { segments: [{ tvl: totalTVL, opacity: 0, isLocked: false }] }
    }

    // Prepare chart data - ordered from highest to lowest (layer 9 to layer 0)
    const chartData = useMemo(() => {
        const data = layers.map((layer) => {
            const { min, max } = getLTVRange(layer)
            const tvl = getLayerTVL(layer)
            const userDepositsInLayer = getDepositsInLayer(userDeposits, layer)
            const hasDeposits = userDepositsInLayer.length > 0
            const tvlValue = Number(tvl) || 0
            const { segments } = calculateLayerLockData(layer, tvlValue)

            return {
                layer,
                range: `${min}-${max}%`,
                tvl: tvlValue,
                hasDeposits,
                userDeposits: userDepositsInLayer,
                segments, // Array of segments with tvl, opacity, and isLocked
            }
        }).reverse() // Reverse to show highest (layer 9) at top, lowest (layer 0) at bottom

        return data
    }, [ltvQueues, userDeposits, allDeposits, layers, ltvMode])

    // Custom bar shape with segments for each deposit/group
    const renderCustomBar = (props: any) => {
        const { x, y, width, height, payload } = props

        if (!payload) {
            return <rect x={x} y={y} width={width || 0} height={height} fill="rgba(255, 255, 255, 0.2)" />
        }

        const { segments = [], tvl = 0 } = payload

        if (!tvl || tvl === 0 || !width || width === 0 || !segments || segments.length === 0) {
            // Fallback to simple gray bar if no data
            return <rect x={x} y={y} width={width || 0} height={height} fill="rgba(255, 255, 255, 0.2)" />
        }

        // Sort segments: unlocked first (gray), then locked by opacity (lightest to darkest)
        const sortedSegments = [...segments].sort((a, b) => {
            if (!a.isLocked && b.isLocked) return -1
            if (a.isLocked && !b.isLocked) return 1
            if (a.isLocked && b.isLocked) return a.opacity - b.opacity
            return 0
        })

        let currentX = x
        const rectSegments: JSX.Element[] = []

        sortedSegments.forEach((segment, index) => {
            const segmentWidth = (segment.tvl / tvl) * width

            if (segmentWidth > 0) {
                const fill = segment.isLocked
                    ? `rgba(96, 165, 250, ${segment.opacity})` // Blue with opacity based on lock duration
                    : 'rgba(255, 255, 255, 0.2)' // Gray for unlocked

                rectSegments.push(
                    <rect
                        key={`segment-${index}`}
                        x={currentX}
                        y={y}
                        width={segmentWidth}
                        height={height}
                        fill={fill}
                    />
                )
                currentX += segmentWidth
            }
        })

        // If no segments were created, show default gray bar
        if (rectSegments.length === 0) {
            return <rect x={x} y={y} width={width} height={height} fill="rgba(255, 255, 255, 0.2)" />
        }

        return <g>{rectSegments}</g>
    }

    return (
        <Box
            w="100%"
            maxW="1000px"
            mx="auto"
            mb={8}
        >
            {/* Toggle between max_LTV and max_borrow_LTV */}
            <HStack mb={4} spacing={4} justify="center">
                <Button
                    size="sm"
                    variant={ltvMode === 'max_ltv' ? 'solid' : 'outline'}
                    colorScheme="blue"
                    onClick={() => setLtvMode('max_ltv')}
                >
                    Max LTV
                </Button>
                <Button
                    size="sm"
                    variant={ltvMode === 'max_borrow_ltv' ? 'solid' : 'outline'}
                    colorScheme="blue"
                    onClick={() => setLtvMode('max_borrow_ltv')}
                >
                    Max Borrow LTV
                </Button>
            </HStack>

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
                    <Bar dataKey="tvl" radius={0} minPointSize={1} shape={renderCustomBar}>
                        {chartData.map((entry, index) => (
                            <Cell key={`cell-${index}`} />
                        ))}
                    </Bar>
                </BarChart>
            </ResponsiveContainer>
        </Box>
    )
})

ForcefieldBarriers.displayName = 'ForcefieldBarriers'
