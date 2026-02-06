import React, { useRef, useEffect, useState, useMemo } from 'react'
import { Box, HStack, Text, IconButton, Tooltip } from '@chakra-ui/react'
import { ChevronLeftIcon, ChevronRightIcon } from '@chakra-ui/icons'
import { motion, AnimatePresence } from 'framer-motion'

// Color constants
const PRIMARY_PURPLE = 'rgb(166, 146, 255)'
const CURRENT_LTV_COLOR = 'rgb(255, 215, 0)' // Gold/yellow for current LTV

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

const LTV_MIN = 0.60 // 60%
const LTV_MAX = 0.90 // 90%
const LTV_STEP = 0.01 // 1% increments

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

    // Determine which values to show labels for (min and max only)
    const shouldShowLabel = (ltv: number): boolean => {
        const percent = Math.round(ltv * 100)
        return (
            percent === 60 || // Min
            percent === 90 // Max
        )
    }

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
    useEffect(() => {
        const handleKeyPress = (e: KeyboardEvent) => {
            // Only handle if not typing in an input
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
                return
            }

            if (e.key === 'ArrowLeft') {
                e.preventDefault()
                if (selectedLTV === null) {
                    const targetLTV = currentLTV !== null ? currentLTV : (ltvValues.length > 0 ? ltvValues[0].ltv : allLTVValues[0])
                    onLTVSelect(targetLTV)
                } else {
                    const currentIndex = allLTVValues.findIndex((v) => Math.abs(v - selectedLTV) < 0.001)
                    if (currentIndex > 0) {
                        onLTVSelect(allLTVValues[currentIndex - 1])
                    }
                }
            } else if (e.key === 'ArrowRight') {
                e.preventDefault()
                if (selectedLTV === null) {
                    const targetLTV = currentLTV !== null ? currentLTV : (ltvValues.length > 0 ? ltvValues[0].ltv : allLTVValues[0])
                    onLTVSelect(targetLTV)
                } else {
                    const currentIndex = allLTVValues.findIndex((v) => Math.abs(v - selectedLTV) < 0.001)
                    if (currentIndex >= 0 && currentIndex < allLTVValues.length - 1) {
                        onLTVSelect(allLTVValues[currentIndex + 1])
                    }
                }
            }
        }

        window.addEventListener('keydown', handleKeyPress)
        return () => window.removeEventListener('keydown', handleKeyPress)
    }, [selectedLTV, currentLTV, ltvValues, allLTVValues, onLTVSelect])

    // Scroll selected LTV to center under fixed frame
    useEffect(() => {
        if (selectedLTV && containerRef.current) {
            const notchElement = containerRef.current.querySelector(
                `[data-ltv="${selectedLTV}"]`
            ) as HTMLElement
            if (notchElement && containerRef.current) {
                const container = containerRef.current
                const containerRect = container.getBoundingClientRect()
                const notchRect = notchElement.getBoundingClientRect()
                const scrollLeft = container.scrollLeft
                const notchOffset = notchRect.left - containerRect.left + scrollLeft
                const containerCenter = containerRect.width / 2
                const targetScroll = notchOffset - containerCenter

                container.scrollTo({
                    left: targetScroll,
                    behavior: 'smooth'
                })
            }
        }
    }, [selectedLTV])

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
                        {(() => {
                            const isAtMin = selectedLTV <= LTV_MIN
                            const isConstraintViolation = !canMove.left && otherLTV !== null && otherLTV !== undefined && !isAtMin

                            return (
                                <Tooltip
                                    label={
                                        isConstraintViolation
                                            ? isLiquidationLTV
                                                ? `Liquidation LTV must be greater than Borrow LTV (${Math.round(otherLTV * 100)}%)`
                                                : `Borrow LTV must be less than Liquidation LTV (${Math.round(otherLTV * 100)}%)`
                                            : isAtMin
                                                ? 'Minimum LTV reached'
                                                : 'Previous LTV'
                                    }
                                    placement="top"
                                    hasArrow
                                    isDisabled={!isConstraintViolation && !isAtMin}
                                    openDelay={300}
                                    bg="rgba(10, 10, 10, 0.95)"
                                    color="white"
                                    border="2px solid"
                                    borderColor={PRIMARY_PURPLE}
                                    borderRadius="md"
                                    boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
                                    backdropFilter="blur(10px)"
                                    fontSize="xs"
                                    fontFamily="mono"
                                    px={3}
                                    py={2}
                                    maxW="200px"
                                    minw="164px"
                                >
                                    <Box
                                        as="button"
                                        onClick={(e: React.MouseEvent) => {
                                            e.stopPropagation()
                                            if (canMove.left && !isAtMin) {
                                                handleArrowClick('left')
                                            }
                                        }}
                                        bg="transparent"
                                        border="none"
                                        cursor={isAtMin || isConstraintViolation ? "not-allowed" : "pointer"}
                                        p={2}
                                        _hover={!isAtMin && !isConstraintViolation ? { opacity: 0.8 } : {}}
                                        display="flex"
                                        flexDirection="column"
                                        alignItems="center"
                                        aria-label="Previous LTV"
                                        pointerEvents="auto"
                                        opacity={isConstraintViolation ? 0.3 : (isAtMin ? 0.5 : 1)}
                                        position="relative"
                                    >
                                        <ChevronLeftIcon
                                            color={isConstraintViolation ? "red.400" : PRIMARY_PURPLE}
                                            boxSize={6}
                                            style={{
                                                filter: isConstraintViolation
                                                    ? 'drop-shadow(0 0 8px rgba(248, 113, 113, 0.4))'
                                                    : 'drop-shadow(0 0 8px rgba(166, 146, 255, 0.6))',
                                            }}
                                        />
                                        {/* Warning icon for constraint violation only */}
                                        {isConstraintViolation && (
                                            <Box
                                                position="absolute"
                                                top="-4px"
                                                right="-4px"
                                                bg="red.500"
                                                borderRadius="full"
                                                w="12px"
                                                h="12px"
                                                display="flex"
                                                alignItems="center"
                                                justifyContent="center"
                                                border="2px solid"
                                                borderColor="rgba(10, 10, 10, 0.95)"
                                            >
                                                <Text fontSize="8px" color="white" fontWeight="bold">!</Text>
                                            </Box>
                                        )}
                                    </Box>
                                </Tooltip>
                            )
                        })()}

                        {/* Selected Frame */}
                        <motion.div
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ duration: 0.2 }}
                            style={{
                                width: '80px',
                                height: '60px',
                                border: `2px solid ${PRIMARY_PURPLE}`,
                                borderRadius: '8px',
                                background: 'rgba(10, 10, 10, 0.95)',
                                boxShadow: `0 0 20px ${PRIMARY_PURPLE}`,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}
                        >
                            <Text
                                fontSize="xl"
                                fontWeight="bold"
                                color={PRIMARY_PURPLE}
                                fontFamily="mono"
                            >
                                {Math.round(selectedLTV * 100)}%
                            </Text>
                        </motion.div>

                        {/* Right Arrow */}
                        {(() => {
                            const isAtMax = selectedLTV >= LTV_MAX
                            const isConstraintViolation = !canMove.right && otherLTV !== null && otherLTV !== undefined && !isAtMax

                            return (
                                <Tooltip
                                    label={
                                        isConstraintViolation
                                            ? isLiquidationLTV
                                                ? `Liquidation LTV must be greater than Borrow LTV (${Math.round(otherLTV * 100)}%)`
                                                : `Borrow LTV must be less than Liquidation LTV (${Math.round(otherLTV * 100)}%)`
                                            : isAtMax
                                                ? 'Maximum LTV reached'
                                                : 'Next LTV'
                                    }
                                    placement="top"
                                    hasArrow
                                    isDisabled={!isConstraintViolation && !isAtMax}
                                    openDelay={300}
                                    bg="rgba(10, 10, 10, 0.95)"
                                    color="white"
                                    border="2px solid"
                                    borderColor={PRIMARY_PURPLE}
                                    borderRadius="md"
                                    boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
                                    backdropFilter="blur(10px)"
                                    fontSize="xs"
                                    fontFamily="mono"
                                    px={3}
                                    py={2}
                                    maxW="200px"
                                >
                                    <Box
                                        as="button"
                                        onClick={(e: React.MouseEvent) => {
                                            e.stopPropagation()
                                            if (canMove.right && !isAtMax) {
                                                handleArrowClick('right')
                                            }
                                        }}
                                        bg="transparent"
                                        border="none"
                                        cursor={isAtMax || isConstraintViolation ? "not-allowed" : "pointer"}
                                        p={2}
                                        _hover={!isAtMax && !isConstraintViolation ? { opacity: 0.8 } : {}}
                                        display="flex"
                                        flexDirection="column"
                                        alignItems="center"
                                        aria-label="Next LTV"
                                        pointerEvents="auto"
                                        opacity={isConstraintViolation ? 0.3 : (isAtMax ? 0.5 : 1)}
                                        position="relative"
                                    >
                                        <ChevronRightIcon
                                            color={isConstraintViolation ? "red.400" : PRIMARY_PURPLE}
                                            boxSize={6}
                                            style={{
                                                filter: isConstraintViolation
                                                    ? 'drop-shadow(0 0 8px rgba(248, 113, 113, 0.4))'
                                                    : 'drop-shadow(0 0 8px rgba(166, 146, 255, 0.6))',
                                            }}
                                        />
                                        {/* Warning icon for constraint violation only */}
                                        {isConstraintViolation && (
                                            <Box
                                                position="absolute"
                                                top="-4px"
                                                left="-4px"
                                                bg="red.500"
                                                borderRadius="full"
                                                w="12px"
                                                h="12px"
                                                display="flex"
                                                alignItems="center"
                                                justifyContent="center"
                                                border="2px solid"
                                                borderColor="rgba(10, 10, 10, 0.95)"
                                            >
                                                <Text fontSize="8px" color="white" fontWeight="bold">!</Text>
                                            </Box>
                                        )}
                                    </Box>
                                </Tooltip>
                            )
                        })()}
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
                            const percent = Math.round(ltv * 100)
                            const showLabel = shouldShowLabel(ltv)

                            // Calculate notch height based on state
                            let notchHeight = 8
                            if (isSelected) notchHeight = 40
                            else if (isHovered) notchHeight = 20
                            else if (isCurrent) notchHeight = 16
                            else if (hasData) notchHeight = 12

                            // Determine colors
                            let notchColor = PRIMARY_PURPLE
                            let glowColor = PRIMARY_PURPLE
                            if (isCurrent) {
                                notchColor = CURRENT_LTV_COLOR
                                glowColor = CURRENT_LTV_COLOR
                            } else if (isSelected) {
                                notchColor = PRIMARY_PURPLE
                                glowColor = PRIMARY_PURPLE
                            } else if (isHovered) {
                                notchColor = PRIMARY_PURPLE
                                glowColor = PRIMARY_PURPLE
                            } else if (!hasData) {
                                notchColor = 'rgba(166, 146, 255, 0.3)'
                                glowColor = 'transparent'
                            }

                            return (
                                <Box
                                    key={ltv}
                                    data-ltv={ltv}
                                    position="relative"
                                    flex={1}
                                    display="flex"
                                    flexDirection="column"
                                    alignItems="center"
                                    cursor="pointer"
                                    onClick={() => handleNotchClick(ltv)}
                                    onMouseEnter={() => handleNotchHover(ltv)}
                                    onMouseLeave={() => handleNotchHover(null)}
                                    style={{ minWidth: '2px' }}
                                >
                                    {/* Notch */}
                                    <motion.div
                                        animate={{
                                            height: `${notchHeight}px`,
                                            opacity: hasData ? 1 : 0.5,
                                        }}
                                        transition={{ duration: 0.2 }}
                                        style={{
                                            width: '2px',
                                            backgroundColor: notchColor,
                                            boxShadow: isSelected || isHovered || isCurrent
                                                ? `0 0 ${isSelected ? '15px' : '8px'} ${glowColor}`
                                                : 'none',
                                            borderRadius: '1px',
                                            position: 'relative',
                                        }}
                                    />

                                    {/* Label */}
                                    {showLabel && (
                                        <Text
                                            display={{ base: 'none', md: 'undefined' }}
                                            fontSize="xs"
                                            color={
                                                isCurrent
                                                    ? CURRENT_LTV_COLOR
                                                    : isSelected || isHovered
                                                        ? PRIMARY_PURPLE
                                                        : 'whiteAlpha.600'
                                            }
                                            fontFamily="mono"
                                            fontWeight={isCurrent || isSelected ? 'bold' : 'normal'}
                                            mt={1}
                                            textShadow={
                                                isCurrent || isSelected
                                                    ? `0 0 8px ${isCurrent ? CURRENT_LTV_COLOR : PRIMARY_PURPLE}`
                                                    : undefined
                                            }
                                        >
                                            {percent}%
                                        </Text>
                                    )}
                                </Box>
                            )
                        })}
                    </HStack>
                </HStack>
            </Box>
        </Box>
    )
}

