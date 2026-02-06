import React, { useState, useEffect, useMemo, useRef } from 'react'
import { Box, VStack, HStack, Text, Flex } from '@chakra-ui/react'
import { motion, AnimatePresence } from 'framer-motion'
import { useDiscoAssets, useDailyTVL, useDiscoUserMetrics } from '@/hooks/useDiscoData'
import { useQueries, useQuery } from '@tanstack/react-query'
import { getLTVQueue } from '@/services/disco'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import { shiftDigits } from '@/helpers/math'
import { getDiscoTotalInsurance } from '@/services/flywheel'

// Color constants
const PRIMARY_PURPLE = 'rgb(166, 146, 255)'
const DARK_BG = '#0A0A0A'
const NEON_BLUE = '#00bfff'
const WELD_WHITE = '#ffffff'
const WELD_BLUE = '#4fcabb'

// Hex panel constants
const HEX_CENTER_X = 400
const HEX_CENTER_Y = 300
const HEX_RADIUS = 200

interface LTVSegment {
    minLTV: number
    maxLTV: number
    tvl: number
    segmentIndex: number
    opacityRatio: number
}

// Hexagonal Forcefield Panel with LTV Segments
const HexPanel: React.FC<{
    ltvQueues: any[]
    svgRef?: React.RefObject<SVGSVGElement>
}> = ({ ltvQueues, svgRef }) => {
    const [hoveredSegment, setHoveredSegment] = useState<number | null>(null)
    const [selectedSegment, setSelectedSegment] = useState<number | null>(null)
    const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 })

    // Calculate LTV segments (every 3%)
    const segments = useMemo(() => {
        const segmentMap = new Map<number, number>() // segmentIndex -> total TVL

        // Process all LTV queues
        ltvQueues.forEach((query: any) => {
            const queue = query.data?.queue
            if (queue?.slots) {
                queue.slots.forEach((slot: any) => {
                    const ltvStr = slot.ltv
                    const ltv = typeof ltvStr === 'string'
                        ? parseFloat(ltvStr)
                        : parseFloat(ltvStr?.toString() || '0')

                    // Determine which 3% segment this slot belongs to (60-90% range)
                    // Segment 0 = 60-63%, Segment 1 = 63-66%, ..., Segment 9 = 87-90%
                    const segmentIndex = Math.floor((ltv * 100 - 60) / 3)
                    if (segmentIndex >= 0 && segmentIndex < 10 && ltv >= 0.6 && ltv < 0.9) {
                        const depositTokens = slot.total_deposit_tokens
                        const depositTokensStr = typeof depositTokens === 'string'
                            ? depositTokens
                            : depositTokens?.toString() || '0'
                        const tvl = parseFloat(depositTokensStr) || 0

                        if (tvl > 0) {
                            const currentTvl = segmentMap.get(segmentIndex) || 0
                            segmentMap.set(segmentIndex, currentTvl + tvl)
                        }
                    }
                })
            }
        })

        // Convert to array of segments (60-90% range)
        const segmentsArray: LTVSegment[] = []
        for (let i = 0; i < 10; i++) {
            const tvl = segmentMap.get(i) || 0
            if (tvl > 0) {
                segmentsArray.push({
                    minLTV: 0.6 + (i * 0.03), // 60% + (i * 3%)
                    maxLTV: 0.6 + ((i + 1) * 0.03), // 60% + ((i+1) * 3%)
                    tvl: tvl,
                    segmentIndex: i,
                    opacityRatio: 0, // Will be calculated below
                })
            }
        }

        // Add mock data if no segments found (for visualization)
        if (segmentsArray.length === 0) {
            // Create mock segments with varying TVL amounts
            const mockSegments = [
                { segmentIndex: 9, tvl: 5000000 },   // 87-90% (innermost)
                { segmentIndex: 8, tvl: 8000000 },   // 84-87%
                { segmentIndex: 7, tvl: 12000000 },  // 81-84%
                { segmentIndex: 6, tvl: 15000000 },  // 78-81%
                { segmentIndex: 5, tvl: 20000000 },  // 75-78%
                { segmentIndex: 4, tvl: 18000000 },  // 72-75%
                { segmentIndex: 3, tvl: 25000000 },  // 69-72%
                { segmentIndex: 2, tvl: 30000000 },  // 66-69%
                { segmentIndex: 1, tvl: 35000000 },  // 63-66%
                { segmentIndex: 0, tvl: 40000000 },  // 60-63% (outermost)
            ]

            mockSegments.forEach((mock) => {
                segmentsArray.push({
                    minLTV: 0.6 + (mock.segmentIndex * 0.03),
                    maxLTV: 0.6 + ((mock.segmentIndex + 1) * 0.03),
                    tvl: mock.tvl,
                    segmentIndex: mock.segmentIndex,
                    opacityRatio: 0, // Will be calculated below
                })
            })
        }

        // Calculate total TVL for opacity ratio
        const totalTvl = segmentsArray.reduce((sum, seg) => sum + seg.tvl, 0)

        // Add opacity ratio to each segment
        return segmentsArray.map(segment => ({
            ...segment,
            opacityRatio: totalTvl > 0 ? segment.tvl / totalTvl : 0,
        }))
    }, [ltvQueues])

    // Calculate size for each segment
    // Each layer is 9% smaller than the previous one
    // position: 0 = outermost (first rendered), higher = more inner
    const getSegmentSize = (position: number): number => {
        // Start from 90% of main radius and each subsequent layer is 9% smaller
        const baseSize = HEX_RADIUS * 1.8 // Diameter for hexagon (radius * 2)
        const scaleFactor = Math.pow(0.91, position) // Each layer is 91% of previous (9% smaller)
        return baseSize * scaleFactor
    }

    // Generate hexagon points for hover area
    const generateHexPoints = (centerX: number, centerY: number, size: number): string => {
        const radius = size / 2
        const points: string[] = []
        for (let i = 0; i < 6; i++) {
            const angle = (i * Math.PI) / 3
            const x = centerX + radius * Math.cos(angle)
            const y = centerY + radius * Math.sin(angle)
            points.push(`${x},${y}`)
        }
        return points.join(' ')
    }

    // Memoize opacity values for each segment to prevent recalculation on hover
    const segmentOpacities = useMemo(() => {
        const totalTvl = segments.reduce((sum, seg) => sum + seg.tvl, 0)
        return segments.map(segment => ({
            segmentIndex: segment.segmentIndex,
            baseOpacity: totalTvl > 0
                ? Math.max(0.0, Math.min(1, 0.0 + (segment.tvl / totalTvl) * 3))
                : 0.3,
        }))
    }, [segments])

    const handleHexInteraction = (
        segmentIndex: number,
        event: React.MouseEvent<SVGElement> | React.TouchEvent<SVGElement>,
        svgRef?: React.RefObject<SVGSVGElement>
    ) => {
        if (svgRef?.current) {
            const svg = svgRef.current
            const pt = svg.createSVGPoint()

            if (event.type.includes('mouse')) {
                const mouseEvent = event as React.MouseEvent<SVGElement>
                pt.x = mouseEvent.clientX
                pt.y = mouseEvent.clientY
            } else {
                const touchEvent = event as React.TouchEvent<SVGElement>
                pt.x = touchEvent.touches[0].clientX
                pt.y = touchEvent.touches[0].clientY
            }

            const svgPt = pt.matrixTransform(svg.getScreenCTM()?.inverse())
            setTooltipPosition({ x: svgPt.x, y: svgPt.y })
        } else {
            // Fallback to center
            setTooltipPosition({ x: HEX_CENTER_X, y: HEX_CENTER_Y - 100 })
        }

        setSelectedSegment(segmentIndex)
        setHoveredSegment(segmentIndex)
    }

    // Find the segment data
    const getSegmentData = (segmentIndex: number): LTVSegment | undefined => {
        return segments.find(s => s.segmentIndex === segmentIndex)
    }

    return (
        <g>
            {/* Outer hex main - using MBRN hexagon SVG */}
            <image
                href="/images/MBRN-hexagon.svg"
                x={HEX_CENTER_X - HEX_RADIUS}
                y={HEX_CENTER_Y - HEX_RADIUS}
                width={HEX_RADIUS * 2}
                height={HEX_RADIUS * 2}
                opacity={0.8}
            />

            {/* LTV Segment Hexagons - render from largest to smallest */}
            {/* Higher LTV = larger hex (outer), Lower LTV = smaller hex (inner) */}
            {segments
                .sort((a, b) => b.segmentIndex - a.segmentIndex) // Sort by segmentIndex descending (higher LTV = outer)
                .map((segment, position) => {
                    // Position in sorted array determines size (0 = outermost)
                    const size = getSegmentSize(position)
                    const isHovered = hoveredSegment === segment.segmentIndex
                    const isSelected = selectedSegment === segment.segmentIndex
                    const x = HEX_CENTER_X - size / 2
                    const y = HEX_CENTER_Y - size / 2

                    // Get pre-calculated opacity from memoized values
                    const opacityData = segmentOpacities.find((op: { segmentIndex: number; baseOpacity: number }) => op.segmentIndex === segment.segmentIndex)
                    const baseOpacity = opacityData?.baseOpacity ?? 0.3
                    const hoverOpacity = Math.min(1.0, baseOpacity + 0.2)

                    const hexPoints = generateHexPoints(HEX_CENTER_X, HEX_CENTER_Y, size)

                    return (
                        <g key={segment.segmentIndex}>
                            {/* MBRN Hexagon SVG */}
                            <motion.image
                                href="/images/MBRN-hexagon.svg"
                                x={x}
                                y={y}
                                width={size}
                                height={size}
                                opacity={baseOpacity}
                                style={{ cursor: 'pointer', pointerEvents: 'none' }}
                                animate={isHovered || isSelected ? { opacity: hoverOpacity } : { opacity: baseOpacity }}
                                transition={{ duration: 0.2 }}
                                filter={(isHovered || isSelected) ? "url(#glow)" : undefined}
                            />
                            {/* Invisible hexagon polygon for precise hover detection */}
                            <polygon
                                points={hexPoints}
                                fill="transparent"
                                style={{ cursor: 'pointer' }}
                                onMouseEnter={() => setHoveredSegment(segment.segmentIndex)}
                                onMouseLeave={() => {
                                    if (selectedSegment !== segment.segmentIndex) {
                                        setHoveredSegment(null)
                                    }
                                }}
                                onClick={(e) => handleHexInteraction(segment.segmentIndex, e, svgRef)}
                                onTouchStart={(e) => handleHexInteraction(segment.segmentIndex, e, svgRef)}
                            />
                        </g>
                    )
                })}


            {/* Tooltip/Data Panel */}
            {(hoveredSegment !== null || selectedSegment !== null) && (() => {
                const segment = getSegmentData(hoveredSegment !== null ? hoveredSegment : selectedSegment!)
                if (!segment) return null

                return (
                    <foreignObject
                        x={tooltipPosition.x + 20}
                        y={tooltipPosition.y - 80}
                        width="200"
                        height="150"
                    >
                        <Box
                            bg="rgba(10, 10, 10, 0.95)"
                            border="2px solid"
                            borderColor={PRIMARY_PURPLE}
                            p={3}
                            borderRadius="md"
                            boxShadow={`0 0 20px ${PRIMARY_PURPLE}`}
                        >
                            <VStack align="stretch" spacing={2}>
                                <Text
                                    fontSize="sm"
                                    fontWeight="bold"
                                    color={PRIMARY_PURPLE}
                                    fontFamily="mono"
                                >
                                    LTV: {(segment.minLTV * 100).toFixed(0)}% - {(segment.maxLTV * 100).toFixed(0)}%
                                </Text>
                                <Text
                                    fontSize="xs"
                                    color="whiteAlpha.700"
                                    fontFamily="mono"
                                >
                                    TVL: {parseFloat(shiftDigits(segment.tvl.toString(), -6).toString()).toLocaleString()} MBRN
                                </Text>
                            </VStack>
                        </Box>
                    </foreignObject>
                )
            })()}
        </g>
    )
}

// Data Panel Component
const DataPanel: React.FC<{
    totalDeposits: number
    averageLTV: number
    activeTranches: number
    yieldRange: string
    pendingRevenue: number
    totalInsurance: number
    recentLiquidations: number
}> = ({ totalDeposits, averageLTV, activeTranches, yieldRange, pendingRevenue, totalInsurance, recentLiquidations }) => {
    const MetricRow: React.FC<{ label: string; value: string | number; unit?: string }> = ({
        label,
        value,
        unit = '',
    }) => (
        <VStack align="stretch" spacing={1} mb={4}>
            <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="1px">
                {label}
            </Text>
            <HStack>
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.5 }}
                >
                    <Text
                        fontSize="2xl"
                        fontWeight="bold"
                        color={PRIMARY_PURPLE}
                        fontFamily="mono"
                        textShadow={`0 0 10px ${PRIMARY_PURPLE}`}
                    >
                        {typeof value === 'number' ? value.toLocaleString() : value}
                    </Text>
                </motion.div>
                {unit && (
                    <Text fontSize="sm" color="whiteAlpha.500" fontFamily="mono">
                        {unit}
                    </Text>
                )}
            </HStack>
            <Box
                h="1px"
                bgGradient={`linear(to-r, transparent, ${PRIMARY_PURPLE}, transparent)`}
                opacity={0.5}
            />
        </VStack>
    )

    return (
        <Box
            w="100%"
            h="100%"
            bg="rgba(10, 10, 10, 0.8)"
            borderLeft="2px solid"
            borderColor={PRIMARY_PURPLE}
            p={6}
            position="relative"
            overflowY="auto"
        >
            {/* HUD Header */}
            <VStack align="stretch" mb={6}>
                <Text
                    fontSize="lg"
                    fontWeight="bold"
                    color={PRIMARY_PURPLE}
                    fontFamily="mono"
                    letterSpacing="2px"
                    textTransform="uppercase"
                    mb={2}
                >
                    LTV Disco Metrics
                </Text>
                <Box h="2px" bg={PRIMARY_PURPLE} opacity={0.6} />
            </VStack>

            {/* Metrics */}
            <VStack align="stretch" spacing={0}>
                <MetricRow label="Total MBRN Deposited" value={totalDeposits} unit="MBRN" />
                <MetricRow label="Average LTV Exposure" value={`${(averageLTV * 100).toFixed(2)}%`} />
                <MetricRow label="Active Tranches" value={activeTranches} />
                <MetricRow label="Total Insurance" value={totalInsurance} unit="CDT" />
                <MetricRow label="Yield Range" value={yieldRange} />
                <MetricRow label="Pending Revenue" value={pendingRevenue} unit="CDT" />
                <MetricRow label="Recent Liquidations (1h)" value={recentLiquidations} />
            </VStack>

            {/* HUD Grid Overlay */}
            <Box
                position="absolute"
                inset={0}
                pointerEvents="none"
                opacity={0.1}
                backgroundImage="linear-gradient(rgba(166, 146, 255, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(166, 146, 255, 0.1) 1px, transparent 1px)"
                backgroundSize="20px 20px"
            />
        </Box>
    )
}

// Main Component
export const WeldingArmScene: React.FC = () => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)
    const { data: assets } = useDiscoAssets()
    const { data: dailyTVL } = useDailyTVL()
    const { deposits, pendingClaims, lifetimeRevenue } = useDiscoUserMetrics(undefined)
    const { data: totalInsurance } = useQuery({
        queryKey: ['disco', 'total_insurance', appState.rpcUrl],
        queryFn: () => getDiscoTotalInsurance(client || null),
        enabled: !!client,
        staleTime: 1000 * 60 * 5,
    })

    // Query LTV queues for all assets
    const ltvQueueQueries = useQueries({
        queries: (assets?.assets || []).map((asset: string) => ({
            queryKey: ['disco', 'ltv_queue', asset, appState.rpcUrl],
            queryFn: () => getLTVQueue(client || null, asset),
            enabled: !!client && !!asset,
            staleTime: 1000 * 60 * 5,
        })),
    })

    // Calculate metrics
    const metrics = useMemo(() => {
        const totalDeposits =
            deposits?.reduce((sum: number, d: any) => {
                const value = shiftDigits(d.vault_tokens || '0', -6)
                return sum + parseFloat(typeof value === 'object' ? value.toString() : String(value))
            }, 0) || 0

        // Calculate average LTV from queues
        let totalWeightedLTV = 0
        let totalWeight = 0
        let activeTranches = 0

        ltvQueueQueries.forEach((query: any) => {
            const queue = query.data?.queue
            if (queue?.slots) {
                queue.slots.forEach((slot: any) => {
                    // Handle Uint128 and Decimal types from CosmWasm
                    const depositTokens = slot.total_deposit_tokens
                    const depositTokensStr = typeof depositTokens === 'string'
                        ? depositTokens
                        : depositTokens?.toString() || '0'
                    const weight = parseFloat(depositTokensStr) || 0

                    if (weight > 0) {
                        const ltvStr = slot.ltv
                        const ltv = typeof ltvStr === 'string'
                            ? parseFloat(ltvStr)
                            : parseFloat(ltvStr?.toString() || '0')
                        totalWeightedLTV += ltv * weight
                        totalWeight += weight
                    }
                    if (slot.deposit_groups && Array.isArray(slot.deposit_groups)) {
                        activeTranches += slot.deposit_groups.length
                    }
                })
            }
        })

        const averageLTV = totalWeight > 0 ? totalWeightedLTV / totalWeight : 0

        // Calculate yield rate (simplified - revenue / deposits)
        const totalRevenue = lifetimeRevenue?.reduce((sum: number, entry: any) => {
            const value = shiftDigits(entry.total_revenue || '0', -6)
            return sum + parseFloat(typeof value === 'object' ? value.toString() : String(value))
        }, 0) || 0

        // Calculate yield range (min and max from different tranches)
        // For now, use a simplified range based on average
        const avgYield = totalDeposits > 0 ? totalRevenue / totalDeposits : 0
        const yieldMin = Math.max(0, avgYield * 0.7)
        const yieldMax = avgYield * 1.3
        const yieldRange = `${(yieldMin * 100).toFixed(2)}% - ${(yieldMax * 100).toFixed(2)}%`

        // Pending revenue (from pending claims)
        const pendingRevenue = pendingClaims?.reduce((sum: number, claim: any) => {
            const value = shiftDigits(claim.pending_amount || '0', -6)
            return sum + parseFloat(typeof value === 'object' ? value.toString() : String(value))
        }, 0) || 0

        // Total insurance
        const totalInsuranceValue = totalInsurance
            ? parseFloat(shiftDigits(totalInsurance.toString(), -6).toString())
            : 0

        // Recent liquidations (placeholder - would need actual liquidation data)
        const recentLiquidations = 0 // TODO: Query actual liquidation events

        return {
            totalDeposits: totalDeposits || 8500, // Fallback for demo
            averageLTV: averageLTV || 0.65,
            activeTranches: activeTranches || 12,
            yieldRange: yieldRange || '5.60% - 10.40%',
            pendingRevenue: pendingRevenue || 1250,
            totalInsurance: totalInsuranceValue || 3500,
            recentLiquidations: recentLiquidations || 0,
        }
    }, [deposits, ltvQueueQueries, lifetimeRevenue, pendingClaims, totalInsurance])

    const svgRef = useRef<SVGSVGElement>(null)

    return (
        <Flex
            w="100%"
            h="100vh"
            bg={DARK_BG}
            position="relative"
            overflow="hidden"
        >
            {/* Left 70% - Welding Scene */}
            <Box
                w="70%"
                h="100%"
                position="relative"
                bg="radial-gradient(circle at center, rgba(166, 146, 255, 0.05) 0%, transparent 70%)"
            >
                <Box
                    w="100%"
                    h="100%"
                    position="relative"
                >
                    <svg
                        ref={svgRef}
                        width="100%"
                        height="100%"
                        viewBox="0 0 800 600"
                        preserveAspectRatio="xMidYMid meet"
                        style={{ filter: 'drop-shadow(0 0 20px rgba(166, 146, 255, 0.3))' }}
                    >
                        <defs>
                            {/* Glow filters */}
                            <filter id="glow">
                                <feGaussianBlur stdDeviation="3" result="coloredBlur" />
                                <feMerge>
                                    <feMergeNode in="coloredBlur" />
                                    <feMergeNode in="SourceGraphic" />
                                </feMerge>
                            </filter>
                            <filter id="weldGlow">
                                <feGaussianBlur stdDeviation="5" result="coloredBlur" />
                                <feMerge>
                                    <feMergeNode in="coloredBlur" />
                                    <feMergeNode in="SourceGraphic" />
                                </feMerge>
                            </filter>
                        </defs>

                        {/* Hex Panel */}
                        <HexPanel ltvQueues={ltvQueueQueries} svgRef={svgRef} />
                    </svg>
                </Box>

                {/* Ambient particles */}
                <Box
                    position="absolute"
                    inset={0}
                    pointerEvents="none"
                    opacity={0.3}
                >
                    {[...Array(20)].map((_, i) => (
                        <motion.div
                            key={i}
                            style={{
                                position: 'absolute',
                                width: '2px',
                                height: '2px',
                                background: PRIMARY_PURPLE,
                                borderRadius: '50%',
                                left: `${Math.random() * 100}%`,
                                top: `${Math.random() * 100}%`,
                            }}
                            animate={{
                                y: [0, -30, 0],
                                opacity: [0, 1, 0],
                            }}
                            transition={{
                                duration: 3 + Math.random() * 2,
                                repeat: Infinity,
                                delay: Math.random() * 2,
                            }}
                        />
                    ))}
                </Box>
            </Box>

            {/* Right 30% - Data Panel */}
            <Box w="30%" h="100%">
                <DataPanel
                    totalDeposits={metrics.totalDeposits}
                    averageLTV={metrics.averageLTV}
                    activeTranches={metrics.activeTranches}
                    yieldRange={metrics.yieldRange}
                    pendingRevenue={metrics.pendingRevenue}
                    totalInsurance={metrics.totalInsurance}
                    recentLiquidations={metrics.recentLiquidations}
                />
            </Box>
        </Flex>
    )
}

