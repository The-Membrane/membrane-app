import React, { useState, useMemo } from 'react'
import { m } from 'framer-motion'
import { shiftDigits } from '@/helpers/math'
import { getSlotLabel } from './types'
import type { DiscoSlot } from './types'

// Color constants
const PRIMARY_PURPLE = 'rgb(155, 220, 79)'

// Hex panel constants
const HEX_CENTER_X = 400
const HEX_CENTER_Y = 300
const HEX_RADIUS = 200

interface HexGraphicProps {
    slots: DiscoSlot[]
    svgRef?: React.RefObject<SVGSVGElement>
    onSlotHover?: (slot: DiscoSlot | null) => void
    onSlotClick?: (slot: DiscoSlot) => void
    asset?: { logo?: string; symbol?: string } | null
}

// Calculate size for each slot hexagon
// Index 0 = outermost/riskiest (largest), last = innermost/safest (smallest)
const getSlotSize = (idx: number): number => {
    const baseSize = HEX_RADIUS * 1.8
    const scaleFactor = Math.pow(0.91, idx)
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

const getSlotId = (slot: DiscoSlot) => Math.round(parseFloat(slot.max_ltv) * 100)

export const HexGraphic: React.FC<HexGraphicProps> = ({ slots, svgRef, onSlotHover, onSlotClick, asset }) => {
    const [hoveredSlot, setHoveredSlot] = useState<number | null>(null)
    const [selectedSlot, setSelectedSlot] = useState<number | null>(null)
    const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 })

    // Use provided slots directly (already sorted descending by max_ltv)
    const allSlots = useMemo(() => {
        if (slots.length > 0) return slots
        // Fallback empty slot
        return [{ max_ltv: "0.50", total_deposit_tokens: "0", total_vault_tokens: "0", bad_debt: "0" }]
    }, [slots])

    // Mock fallback if all slots are empty
    const displaySlots = useMemo(() => {
        const hasAnyTVL = allSlots.some(s => parseFloat(s.total_deposit_tokens) > 0)
        if (hasAnyTVL) return allSlots

        // Mock data for visualization
        const mockTVLs = [40000000000, 35000000000, 30000000000, 25000000000, 20000000000, 15000000000, 12000000000, 8000000000, 5000000000]
        return allSlots.map((slot, i) => ({
            ...slot,
            total_deposit_tokens: mockTVLs[i]?.toString() || "0",
        }))
    }, [allSlots])

    // Memoize opacity values for each slot
    const slotOpacities = useMemo(() => {
        const totalTvl = displaySlots.reduce((sum, s) => sum + parseFloat(s.total_deposit_tokens), 0)
        return displaySlots.map((slot, idx) => {
            const tvl = parseFloat(slot.total_deposit_tokens)
            return {
                idx,
                baseOpacity: totalTvl > 0
                    ? Math.max(0.1, Math.min(1, 0.1 + (tvl / totalTvl) * 3))
                    : 0.3,
            }
        })
    }, [displaySlots])

    const handleHexInteraction = (
        slotIndex: number,
        event: React.MouseEvent<SVGElement> | React.TouchEvent<SVGElement>,
        slot: DiscoSlot
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
                const touch = touchEvent.touches?.[0] || touchEvent.changedTouches?.[0]
                if (touch) {
                    pt.x = touch.clientX
                    pt.y = touch.clientY
                } else {
                    setTooltipPosition({ x: HEX_CENTER_X, y: HEX_CENTER_Y - 100 })
                    setSelectedSlot(slotIndex)
                    setHoveredSlot(slotIndex)
                    onSlotClick?.(slot)
                    return
                }
            }

            const svgPt = pt.matrixTransform(svg.getScreenCTM()?.inverse())
            setTooltipPosition({ x: svgPt.x, y: svgPt.y })
        } else {
            setTooltipPosition({ x: HEX_CENTER_X, y: HEX_CENTER_Y - 100 })
        }

        setSelectedSlot(slotIndex)
        setHoveredSlot(slotIndex)
        onSlotClick?.(slot)
    }

    const handleHover = (
        slotIndex: number | null,
        slot: DiscoSlot | null,
        event?: React.MouseEvent<SVGElement> | React.TouchEvent<SVGElement>
    ) => {
        setHoveredSlot(slotIndex)
        onSlotHover?.(slot || null)

        if (slotIndex !== null && event && svgRef?.current) {
            const svg = svgRef.current
            const pt = svg.createSVGPoint()

            if (event.type.includes('mouse')) {
                const mouseEvent = event as React.MouseEvent<SVGElement>
                pt.x = mouseEvent.clientX
                pt.y = mouseEvent.clientY
            } else {
                const touchEvent = event as React.TouchEvent<SVGElement>
                const touch = touchEvent.touches?.[0] || touchEvent.changedTouches?.[0]
                if (touch) {
                    pt.x = touch.clientX
                    pt.y = touch.clientY
                } else {
                    return
                }
            }

            const svgPt = pt.matrixTransform(svg.getScreenCTM()?.inverse())
            setTooltipPosition({ x: svgPt.x, y: svgPt.y })
        }
    }

    const getSlotData = (slotIndex: number): DiscoSlot | undefined => {
        return displaySlots.find(s => getSlotId(s) === slotIndex)
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
                        filter: 'drop-shadow(0 0 10px rgba(155, 220, 79, 0.5))',
                        pointerEvents: 'none'
                    }}
                />
            )}

            {/* Slot Hexagons - render from outermost (highest LTV) to innermost (lowest LTV) */}
            {displaySlots.map((slot, idx) => {
                    const slotId = getSlotId(slot)
                    const size = getSlotSize(idx)
                    const isHovered = hoveredSlot === slotId
                    const isSelected = selectedSlot === slotId
                    const x = HEX_CENTER_X - size / 2
                    const y = HEX_CENTER_Y - size / 2

                    const opacityData = slotOpacities[idx]
                    const baseOpacity = opacityData?.baseOpacity ?? 0.3
                    const hoverOpacity = Math.min(1.0, baseOpacity + 0.2)

                    const hexPoints = generateHexPoints(HEX_CENTER_X, HEX_CENTER_Y, size)

                    return (
                        <g key={slotId}>
                            {/* MBRN Hexagon SVG */}
                            <m.image
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
                                onMouseEnter={(e) => handleHover(slotId, slot, e)}
                                onMouseMove={(e) => handleHover(slotId, slot, e)}
                                onMouseLeave={() => {
                                    if (selectedSlot !== slotId) {
                                        handleHover(null, null)
                                    }
                                }}
                                onClick={(e) => handleHexInteraction(slotId, e, slot)}
                                onTouchStart={(e) => handleHexInteraction(slotId, e, slot)}
                            />
                        </g>
                    )
                })}

            {/* Tooltip/Data Panel */}
            {(hoveredSlot !== null || selectedSlot !== null) && (() => {
                const slot = getSlotData(hoveredSlot !== null ? hoveredSlot : selectedSlot!)
                if (!slot) return null

                const tooltipX = Math.max(10, Math.min(tooltipPosition.x + 20, 580))
                const tooltipY = Math.max(10, Math.min(tooltipPosition.y - 80, 490))
                const tvl = parseFloat(shiftDigits(slot.total_deposit_tokens, -6).toString())

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
                                Slot {getSlotLabel(Math.round(parseFloat(slot.max_ltv) * 100))}
                            </div>
                            <div style={{ fontSize: '12px', color: 'rgba(255, 255, 255, 0.7)', fontFamily: 'monospace' }}>
                                TVL: {tvl.toLocaleString()} MBRN
                            </div>
                        </div>
                    </foreignObject>
                )
            })()}
        </g>
    )
}
