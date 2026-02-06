import React, { useState, useMemo, useRef } from 'react'
import { Box, VStack, Text } from '@chakra-ui/react'
import { motion } from 'framer-motion'
import { shiftDigits } from '@/helpers/math'

// Color constants
const PRIMARY_PURPLE = 'rgb(166, 146, 255)'

// Hex panel constants
const HEX_CENTER_X = 400
const HEX_CENTER_Y = 300
const HEX_RADIUS = 200

export interface LTVSegment {
    minLTV: number
    maxLTV: number
    tvl: number
    segmentIndex: number
    opacityRatio: number
}

interface HexGraphicProps {
    ltvQueues: any[]
    svgRef?: React.RefObject<SVGSVGElement>
    onSegmentHover?: (segment: LTVSegment | null) => void
    onSegmentClick?: (segment: LTVSegment) => void
    asset?: { logo?: string; symbol?: string } | null // Asset for display inside hexagon
}

export const HexGraphic: React.FC<HexGraphicProps> = ({ ltvQueues, svgRef, onSegmentHover, onSegmentClick, asset }) => {
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
        segment: LTVSegment
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
                // Use touches if available, otherwise fall back to changedTouches
                const touch = touchEvent.touches?.[0] || touchEvent.changedTouches?.[0]
                if (touch) {
                    pt.x = touch.clientX
                    pt.y = touch.clientY
                } else {
                    // Fallback to center if no touch data available
                    setTooltipPosition({ x: HEX_CENTER_X, y: HEX_CENTER_Y - 100 })
                    setSelectedSegment(segmentIndex)
                    setHoveredSegment(segmentIndex)
                    onSegmentClick?.(segment)
                    return
                }
            }

            const svgPt = pt.matrixTransform(svg.getScreenCTM()?.inverse())
            setTooltipPosition({ x: svgPt.x, y: svgPt.y })
        } else {
            // Fallback to center
            setTooltipPosition({ x: HEX_CENTER_X, y: HEX_CENTER_Y - 100 })
        }

        setSelectedSegment(segmentIndex)
        setHoveredSegment(segmentIndex)
        onSegmentClick?.(segment)
    }

    const handleHover = (
        segmentIndex: number | null,
        segment: LTVSegment | null,
        event?: React.MouseEvent<SVGElement> | React.TouchEvent<SVGElement>
    ) => {
        setHoveredSegment(segmentIndex)
        onSegmentHover?.(segment || null)

        // Update tooltip position on hover
        if (segmentIndex !== null && event && svgRef?.current) {
            const svg = svgRef.current
            const pt = svg.createSVGPoint()

            if (event.type.includes('mouse')) {
                const mouseEvent = event as React.MouseEvent<SVGElement>
                pt.x = mouseEvent.clientX
                pt.y = mouseEvent.clientY
            } else {
                const touchEvent = event as React.TouchEvent<SVGElement>
                // Use touches if available, otherwise fall back to changedTouches
                const touch = touchEvent.touches?.[0] || touchEvent.changedTouches?.[0]
                if (touch) {
                    pt.x = touch.clientX
                    pt.y = touch.clientY
                } else {
                    // Skip tooltip position update if no touch data available
                    return
                }
            }

            const svgPt = pt.matrixTransform(svg.getScreenCTM()?.inverse())
            setTooltipPosition({ x: svgPt.x, y: svgPt.y })
        }
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

            {/* Asset Image - centered inside hexagon */}
            {asset?.logo && (
                <image
                    href={asset.logo}
                    x={HEX_CENTER_X - 40}
                    y={HEX_CENTER_Y - 40}
                    width={80}
                    height={80}
                    opacity={0.9}
                    style={{
                        filter: 'drop-shadow(0 0 10px rgba(166, 146, 255, 0.5))',
                        pointerEvents: 'none'
                    }}
                />
            )}

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
                                onMouseEnter={(e) => handleHover(segment.segmentIndex, segment, e)}
                                onMouseMove={(e) => handleHover(segment.segmentIndex, segment, e)}
                                onMouseLeave={() => {
                                    if (selectedSegment !== segment.segmentIndex) {
                                        handleHover(null, null)
                                    }
                                }}
                                onClick={(e) => handleHexInteraction(segment.segmentIndex, e, segment)}
                                onTouchStart={(e) => handleHexInteraction(segment.segmentIndex, e, segment)}
                            />
                        </g>
                    )
                })}

            {/* Tooltip/Data Panel */}
            {(hoveredSegment !== null || selectedSegment !== null) && (() => {
                const segment = getSegmentData(hoveredSegment !== null ? hoveredSegment : selectedSegment!)
                if (!segment) return null

                // Ensure tooltip is within SVG bounds
                const tooltipX = Math.max(10, Math.min(tooltipPosition.x + 20, 580))
                const tooltipY = Math.max(10, Math.min(tooltipPosition.y - 80, 490))

                return (
                    <foreignObject
                        x={tooltipX}
                        y={tooltipY}
                        width="200"
                        height="150"
                        style={{ overflow: 'visible', zIndex: 9999, pointerEvents: 'none' }}
                        xmlns="http://www.w3.org/1999/xhtml"
                    >
                        <div
                            style={{
                                backgroundColor: 'rgba(10, 10, 10, 0.98)',
                                border: `2px solid ${PRIMARY_PURPLE}`,
                                padding: '12px',
                                borderRadius: '8px',
                                boxShadow: `0 0 20px ${PRIMARY_PURPLE}`,
                                color: PRIMARY_PURPLE,
                                fontFamily: 'monospace',
                                position: 'relative',
                                zIndex: 9999,
                            }}
                        >
                            <div style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '8px', color: PRIMARY_PURPLE }}>
                                LTV: {(segment.minLTV * 100).toFixed(0)}% - {(segment.maxLTV * 100).toFixed(0)}%
                            </div>
                            <div style={{ fontSize: '12px', color: 'rgba(255, 255, 255, 0.7)', fontFamily: 'monospace' }}>
                                TVL: {parseFloat(shiftDigits(segment.tvl.toString(), -6).toString()).toLocaleString()} MBRN
                            </div>
                        </div>
                    </foreignObject>
                )
            })()}
        </g>
    )
}

