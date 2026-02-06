import React, { useRef, useEffect, useState, useMemo } from 'react'
import { Box, HStack, Text, Tooltip, NumberInput, NumberInputField } from '@chakra-ui/react'
import { ChevronLeftIcon, ChevronRightIcon } from '@chakra-ui/icons'

// Color constants
const PRIMARY_PURPLE = 'rgb(166, 146, 255)'

interface CompactLTVCarouselProps {
    label: string
    selectedLTV: number
    minLTV: number // e.g., 0.60 for 60%
    maxLTV: number // e.g., 0.90 for 90%
    otherLTV?: number | null // For constraint checking
    isLiquidationLTV?: boolean // true if liquidation, false if borrow
    onLTVSelect: (ltv: number) => void
}

const LTV_STEP = 0.01 // 1% increments

export const CompactLTVCarousel: React.FC<CompactLTVCarouselProps> = ({
    label,
    selectedLTV,
    minLTV,
    maxLTV,
    otherLTV,
    isLiquidationLTV = false,
    onLTVSelect,
}) => {
    const [inputValue, setInputValue] = useState(Math.round(selectedLTV * 100).toString())
    const [bufferedValue, setBufferedValue] = useState<number | null>(null)
    const validationTimeoutRef = useRef<NodeJS.Timeout | null>(null)

    // Update input value when selectedLTV changes externally
    useEffect(() => {
        setInputValue(Math.round(selectedLTV * 100).toString())
        setBufferedValue(null)
    }, [selectedLTV])

    // Use buffered value for validation, otherwise use actual selectedLTV
    const effectiveLTV = bufferedValue !== null ? bufferedValue : selectedLTV

    // Check if arrow navigation is allowed
    const canMove = useMemo(() => {
        if (otherLTV === null || otherLTV === undefined) {
            return { left: true, right: true }
        }

        const currentPercent = Math.round(effectiveLTV * 100)
        const minPercent = Math.round(minLTV * 100)
        const maxPercent = Math.round(maxLTV * 100)

        const leftLTV = currentPercent > minPercent ? (currentPercent - 1) / 100 : null
        const rightLTV = currentPercent < maxPercent ? (currentPercent + 1) / 100 : null

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
    }, [effectiveLTV, otherLTV, isLiquidationLTV, minLTV, maxLTV])

    const handleInputChange = (valueString: string) => {
        setInputValue(valueString)

        // Clear existing timeout
        if (validationTimeoutRef.current) {
            clearTimeout(validationTimeoutRef.current)
        }

        // Parse the input value
        const parsed = parseInt(valueString)
        if (!isNaN(parsed) && valueString !== '') {
            const ltvValue = parsed / 100
            setBufferedValue(ltvValue)

            // Apply validation after 1 second delay (allows typing multi-digit numbers)
            validationTimeoutRef.current = setTimeout(() => {
                const minPercent = Math.round(minLTV * 100)
                const maxPercent = Math.round(maxLTV * 100)
                const clamped = Math.max(minPercent, Math.min(maxPercent, parsed)) / 100
                onLTVSelect(clamped)
                setBufferedValue(null)
                setInputValue(Math.round(clamped * 100).toString())
            }, 1000)
        } else if (valueString === '') {
            // Allow empty input temporarily
            setBufferedValue(null)
        }
    }

    const handleInputBlur = () => {
        // Apply validation immediately on blur
        if (validationTimeoutRef.current) {
            clearTimeout(validationTimeoutRef.current)
        }

        const parsed = parseInt(inputValue)
        if (!isNaN(parsed)) {
            const minPercent = Math.round(minLTV * 100)
            const maxPercent = Math.round(maxLTV * 100)
            const clamped = Math.max(minPercent, Math.min(maxPercent, parsed)) / 100
            onLTVSelect(clamped)
            setBufferedValue(null)
            setInputValue(Math.round(clamped * 100).toString())
        } else {
            // Reset to selectedLTV if invalid
            setInputValue(Math.round(selectedLTV * 100).toString())
            setBufferedValue(null)
        }
    }

    const handleArrowClick = (direction: 'left' | 'right') => {
        const currentPercent = Math.round(effectiveLTV * 100)
        const minPercent = Math.round(minLTV * 100)
        const maxPercent = Math.round(maxLTV * 100)

        if (direction === 'left' && currentPercent > minPercent) {
            const newPercent = currentPercent - 1
            const newLTV = newPercent / 100
            if (canMove.left) {
                onLTVSelect(newLTV)
                setInputValue(newPercent.toString())
                setBufferedValue(null)
            }
        } else if (direction === 'right' && currentPercent < maxPercent) {
            const newPercent = currentPercent + 1
            const newLTV = newPercent / 100
            if (canMove.right) {
                onLTVSelect(newLTV)
                setInputValue(newPercent.toString())
                setBufferedValue(null)
            }
        }
    }

    // Cleanup timeout on unmount
    useEffect(() => {
        return () => {
            if (validationTimeoutRef.current) {
                clearTimeout(validationTimeoutRef.current)
            }
        }
    }, [])

    const isAtMin = effectiveLTV <= minLTV
    const isAtMax = effectiveLTV >= maxLTV
    const isConstraintViolation = otherLTV !== null && otherLTV !== undefined && (
        (isLiquidationLTV && effectiveLTV <= otherLTV) ||
        (!isLiquidationLTV && effectiveLTV >= otherLTV)
    )

    return (
        <Box w="100%" position="relative">
            {/* Label */}
            <Text
                fontSize="xs"
                fontWeight="bold"
                color={PRIMARY_PURPLE}
                fontFamily="mono"
                letterSpacing="0.5px"
                mb={2}
            >
                {label}
            </Text>

            {/* Fixed Frame and Arrows Container */}
            <Box
                position="relative"
                w="100%"
                display="flex"
                alignItems="center"
                justifyContent="center"
                gap={3}
            >
                {/* Left Arrow */}
                <Tooltip
                    label={
                        isConstraintViolation
                            ? isLiquidationLTV
                                ? `Liquidation LTV must be greater than Borrow LTV (${Math.round(otherLTV! * 100)}%)`
                                : `Borrow LTV must be less than Liquidation LTV (${Math.round(otherLTV! * 100)}%)`
                            : isAtMin
                                ? 'Minimum LTV reached'
                                : 'Previous LTV'
                    }
                    placement="top"
                    hasArrow
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
                    isDisabled={!isConstraintViolation && isAtMin}
                    openDelay={300}
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
                        p={1}
                        _hover={!isAtMin && !isConstraintViolation ? { opacity: 0.8 } : {}}
                        display="flex"
                        alignItems="center"
                        aria-label="Previous LTV"
                        opacity={isConstraintViolation ? 0.3 : (isAtMin ? 0.5 : 1)}
                    >
                        <ChevronLeftIcon
                            color={isConstraintViolation ? "red.400" : PRIMARY_PURPLE}
                            boxSize={5}
                            style={{
                                filter: isConstraintViolation
                                    ? 'drop-shadow(0 0 6px rgba(248, 113, 113, 0.4))'
                                    : 'drop-shadow(0 0 6px rgba(166, 146, 255, 0.6))',
                            }}
                        />
                    </Box>
                </Tooltip>

                {/* Input Frame */}
                <Box
                    bg="rgba(10, 10, 10, 0.95)"
                    border="2px solid"
                    borderColor={isConstraintViolation ? "red.400" : PRIMARY_PURPLE}
                    borderRadius="md"
                    px={4}
                    py={2}
                    minW="100px"
                    boxShadow={isConstraintViolation
                        ? '0 0 15px rgba(248, 113, 113, 0.4)'
                        : `0 0 15px ${PRIMARY_PURPLE}40`
                    }
                    backdropFilter="blur(10px)"
                >
                    <HStack spacing={1} align="center" justify="center">
                        <NumberInput
                            value={inputValue}
                            onChange={handleInputChange}
                            onBlur={handleInputBlur}
                            min={Math.round(minLTV * 100)}
                            max={Math.round(maxLTV * 100)}
                            step={1}
                            allowMouseWheel
                        >
                            <NumberInputField
                                bg="transparent"
                                border="none"
                                color={isConstraintViolation ? "red.400" : PRIMARY_PURPLE}
                                fontSize="lg"
                                fontWeight="bold"
                                fontFamily="mono"
                                textAlign="center"
                                p={0}
                                _focus={{
                                    outline: 'none',
                                    boxShadow: 'none',
                                }}
                                _hover={{
                                    outline: 'none',
                                }}
                            />
                        </NumberInput>
                        <Text
                            fontSize="lg"
                            fontWeight="bold"
                            color={isConstraintViolation ? "red.400" : PRIMARY_PURPLE}
                            fontFamily="mono"
                        >
                            %
                        </Text>
                    </HStack>
                </Box>

                {/* Right Arrow */}
                <Tooltip
                    label={
                        isConstraintViolation
                            ? isLiquidationLTV
                                ? `Liquidation LTV must be greater than Borrow LTV (${Math.round(otherLTV! * 100)}%)`
                                : `Borrow LTV must be less than Liquidation LTV (${Math.round(otherLTV! * 100)}%)`
                            : isAtMax
                                ? 'Maximum LTV reached'
                                : 'Next LTV'
                    }
                    placement="top"
                    hasArrow
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
                    isDisabled={!isConstraintViolation && isAtMax}
                    openDelay={300}
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
                        p={1}
                        _hover={!isAtMax && !isConstraintViolation ? { opacity: 0.8 } : {}}
                        display="flex"
                        alignItems="center"
                        aria-label="Next LTV"
                        opacity={isConstraintViolation ? 0.3 : (isAtMax ? 0.5 : 1)}
                    >
                        <ChevronRightIcon
                            color={isConstraintViolation ? "red.400" : PRIMARY_PURPLE}
                            boxSize={5}
                            style={{
                                filter: isConstraintViolation
                                    ? 'drop-shadow(0 0 6px rgba(248, 113, 113, 0.4))'
                                    : 'drop-shadow(0 0 6px rgba(166, 146, 255, 0.6))',
                            }}
                        />
                    </Box>
                </Tooltip>
            </Box>

            {/* Constraint Warning */}
            {isConstraintViolation && (
                <Text fontSize="2xs" color="red.400" mt={1} textAlign="center">
                    {isLiquidationLTV
                        ? 'Liquidation LTV must be greater than Borrow LTV'
                        : 'Borrow LTV must be less than Liquidation LTV'}
                </Text>
            )}
        </Box>
    )
}

