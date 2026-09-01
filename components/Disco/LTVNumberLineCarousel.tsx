import React, { useRef, useState, useMemo } from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'
import { LTVCarouselArrow } from './LTVCarouselArrow'
import { LTVCarouselNotch } from './LTVCarouselNotch'
import { LTVCarouselSelectedFrame } from './LTVCarouselSelectedFrame'
import { PRIMARY_PURPLE, LTV_MIN, LTV_MAX } from './LTVCarouselConstants'
import { useLTVCarouselKeyboardNav, useLTVCarouselScrollToCenter } from './hooks/useLTVCarousel'

export interface IndividualLTVData {
    ltv: number // e.g., 0.75 for 75% (liquidation LTV)
    borrowLTV?: number // Optional borrow LTV for pairs
    tvl: number // Total value locked at this LTV (or LTV pair)
    apr?: string | null // Calculated APR
    slotData?: any // Raw slot data from LTV queue
}

interface LTVNumberLineCarouselProps {
    label: string // "Borrow LTV" or "Liquidation LTV"
    ltvValues: IndividualLTVData[] // All available LTV values with data
    selectedLTV: number | null // Currently selected LTV (as decimal, e.g., 0.75)
    currentLTV: number | null // Protocol's current/average LTV (as decimal)
    onLTVSelect: (ltv: number) => void
    onLTVHover?: (ltv: number | null) => void
    otherLTV?: number | null // The other LTV value for constraint checking
    isLiquidationLTV?: boolean // true if this is liquidation LTV, false if borrow LTV
}

// Determine which values to show labels for (min and max only)
const shouldShowLabel = (ltv: number): boolean => {
    const percent = Math.round(ltv * 100)
    return (
        percent === 60 || // Min
        percent === 90 // Max
    )
}

export const LTVNumberLineCarousel: React.FC<LTVNumberLineCarouselProps> = ({
    label,
    ltvValues,
    selectedLTV,
    currentLTV,
    onLTVSelect,
    onLTVHover,
    otherLTV,
    isLiquidationLTV = false,
}) => {
    const containerRef = useRef<HTMLDivElement>(null)
    const [hoveredLTV, setHoveredLTV] = useState<number | null>(null)

    // Generate all LTV values from 60% to 90% in 1% increments
    const allLTVValues = useMemo(() => {
        const values: number[] = []
        // Use integer math to avoid floating point precision issues
        for (let percent = 60; percent <= 90; percent++) {
            values.push(percent / 100)
        }
        return values
    }, [])

    // Create a map of LTV to data for quick lookup
    const ltvDataMap = useMemo(() => {
        const map = new Map<number, IndividualLTVData>()
        ltvValues.forEach((data) => {
            map.set(data.ltv, data)
        })
        return map
    }, [ltvValues])

    const handleNotchClick = (ltv: number) => {
        onLTVSelect(ltv)
    }

    const handleNotchHover = (ltv: number | null) => {
        setHoveredLTV(ltv)
        onLTVHover?.(ltv)
    }

    // Check if a move in a direction would violate the constraint
    const canMove = useMemo(() => {
        if (!selectedLTV || otherLTV === null || otherLTV === undefined) {
            return { left: true, right: true }
        }

        const currentIndex = allLTVValues.findIndex((v) => Math.abs(v - selectedLTV) < 0.001)
        if (currentIndex === -1) {
            return { left: true, right: true }
        }

        const leftLTV = currentIndex > 0 ? allLTVValues[currentIndex - 1] : null
        const rightLTV = currentIndex < allLTVValues.length - 1 ? allLTVValues[currentIndex + 1] : null

        if (isLiquidationLTV) {
            // Liquidation LTV must be > borrow LTV
            return {
                left: leftLTV !== null && leftLTV > otherLTV,
                right: rightLTV !== null && rightLTV > otherLTV,
            }
        } else {
            // Borrow LTV must be < liquidation LTV
            return {
                left: leftLTV !== null && leftLTV < otherLTV,
                right: rightLTV !== null && rightLTV < otherLTV,
            }
        }
    }, [selectedLTV, otherLTV, isLiquidationLTV, allLTVValues])

    const handleArrowClick = (direction: 'left' | 'right') => {
        // Check constraint before moving
        if (direction === 'left' && !canMove.left) {
            return
        }
        if (direction === 'right' && !canMove.right) {
            return
        }

        if (allLTVValues.length === 0) return

        if (selectedLTV === null) {
            // If nothing selected, select current LTV or first available
            const targetLTV = currentLTV !== null && currentLTV >= LTV_MIN && currentLTV <= LTV_MAX
                ? currentLTV
                : (ltvValues.length > 0 ? ltvValues[0].ltv : allLTVValues[0])
            onLTVSelect(targetLTV)
            return
        }

        const currentIndex = allLTVValues.findIndex((v) => Math.abs(v - selectedLTV) < 0.001)
        if (currentIndex === -1) {
            // If selected LTV not found in all values, find closest
            const closestIndex = allLTVValues.findIndex((v) => v >= selectedLTV)
            const startIndex = closestIndex >= 0 ? closestIndex : allLTVValues.length - 1
            const newIndex = direction === 'left' ? startIndex - 1 : startIndex + 1
            if (newIndex >= 0 && newIndex < allLTVValues.length) {
                onLTVSelect(allLTVValues[newIndex])
            }
            return
        }

        const newIndex = direction === 'left' ? currentIndex - 1 : currentIndex + 1
        if (newIndex >= 0 && newIndex < allLTVValues.length) {
            onLTVSelect(allLTVValues[newIndex])
        } else if (direction === 'right' && currentIndex === allLTVValues.length - 1) {
            // Allow clicking right arrow at max to go to 90%
            onLTVSelect(LTV_MAX)
        }
    }

    // Keyboard navigation
    useLTVCarouselKeyboardNav({ selectedLTV, currentLTV, ltvValues, allLTVValues, onLTVSelect })

    // Scroll selected LTV to center under fixed frame
    useLTVCarouselScrollToCenter(selectedLTV, containerRef)

    const getNotchState = (ltv: number) => {
        const isSelected = selectedLTV !== null && Math.abs(ltv - selectedLTV) < 0.001
        const isCurrent = currentLTV !== null && Math.abs(ltv - currentLTV) < 0.001
        const isHovered = hoveredLTV !== null && Math.abs(ltv - hoveredLTV) < 0.001
        const hasData = ltvDataMap.has(ltv)

        return { isSelected, isCurrent, isHovered, hasData }
    }

    return (
        <Box w="100%" position="relative">
            {/* Label */}
            <Text
                fontSize="sm"
                fontWeight="bold"
                color={PRIMARY_PURPLE}
                fontFamily="mono"
                letterSpacing="1px"
                mb={2}
                textAlign="center"
            >
                {label}
            </Text>

            {/* Carousel Container */}
            <Box
                ref={containerRef}
                position="relative"
                w="100%"
                minH="120px"
                overflowX="auto"
                overflowY="visible"
                css={{
                    '&::-webkit-scrollbar': {
                        display: 'none',
                    },
                    scrollbarWidth: 'none',
                    msOverflowStyle: 'none',
                }}
            >
                {/* Fixed Frame and Arrows - positioned relative to container, not notches */}
                {selectedLTV !== null && (
                    <Box
                        position="absolute"
                        left="50%"
                        bottom="40px"
                        transform="translateX(-50%)"
                        zIndex={10}
                        display="flex"
                        alignItems="center"
                        gap={0}
                        pointerEvents="none"
                    >
                        {/* Left Arrow */}
                        <LTVCarouselArrow
                            direction="left"
                            selectedLTV={selectedLTV}
                            canMove={canMove}
                            otherLTV={otherLTV}
                            isLiquidationLTV={isLiquidationLTV}
                            onArrowClick={handleArrowClick}
                        />

                        {/* Selected Frame */}
                        <LTVCarouselSelectedFrame selectedLTV={selectedLTV} />

                        {/* Right Arrow */}
                        <LTVCarouselArrow
                            direction="right"
                            selectedLTV={selectedLTV}
                            canMove={canMove}
                            otherLTV={otherLTV}
                            isLiquidationLTV={isLiquidationLTV}
                            onArrowClick={handleArrowClick}
                        />
                    </Box>
                )}

                {/* Scrollable Number Line */}
                <HStack
                    spacing={0}
                    align="flex-end"
                    justify="center"
                    minH="120px"
                    px={4}
                    position="relative"
                    w="100%"
                >
                    <HStack
                        spacing={0}
                        flex={1}
                        justify="space-between"
                        align="flex-end"
                        px={2}
                        position="relative"
                        w="100%"
                        minW="max-content"
                    >
                        {allLTVValues.map((ltv) => {
                            const { isSelected, isCurrent, isHovered, hasData } = getNotchState(ltv)
                            const showLabel = shouldShowLabel(ltv)

                            return (
                                <LTVCarouselNotch
                                    key={ltv}
                                    ltv={ltv}
                                    isSelected={isSelected}
                                    isCurrent={isCurrent}
                                    isHovered={isHovered}
                                    hasData={hasData}
                                    showLabel={showLabel}
                                    onSelect={handleNotchClick}
                                    onHover={handleNotchHover}
                                />
                            )
                        })}
                    </HStack>
                </HStack>
            </Box>
        </Box>
    )
}
