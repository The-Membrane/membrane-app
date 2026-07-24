import React from 'react'
import { Box, Text, Tooltip } from '@chakra-ui/react'
import { ChevronLeftIcon, ChevronRightIcon } from '@chakra-ui/icons'
import { PRIMARY_PURPLE, LTV_MIN, LTV_MAX } from './LTVCarouselConstants'

interface LTVCarouselArrowProps {
    direction: 'left' | 'right'
    selectedLTV: number
    canMove: { left: boolean; right: boolean }
    otherLTV?: number | null
    isLiquidationLTV: boolean
    onArrowClick: (direction: 'left' | 'right') => void
}

// A single navigation arrow (previous / next) for the LTV carousel. The
// left/right variants share the same styling; only the limit check, tooltip
// copy, chevron glyph and warning-badge side differ.
export const LTVCarouselArrow: React.FC<LTVCarouselArrowProps> = ({
    direction,
    selectedLTV,
    canMove,
    otherLTV,
    isLiquidationLTV,
    onArrowClick,
}) => {
    const isAtLimit = direction === 'left' ? selectedLTV <= LTV_MIN : selectedLTV >= LTV_MAX
    const canMoveDir = direction === 'left' ? canMove.left : canMove.right
    const isConstraintViolation = !canMoveDir && otherLTV !== null && otherLTV !== undefined && !isAtLimit
    const ChevronIcon = direction === 'left' ? ChevronLeftIcon : ChevronRightIcon

    return (
        <Tooltip
            label={
                isConstraintViolation
                    ? isLiquidationLTV
                        ? `Liquidation LTV must be greater than Borrow LTV (${Math.round(otherLTV * 100)}%)`
                        : `Borrow LTV must be less than Liquidation LTV (${Math.round(otherLTV * 100)}%)`
                    : isAtLimit
                        ? direction === 'left'
                            ? 'Minimum LTV reached'
                            : 'Maximum LTV reached'
                        : direction === 'left'
                            ? 'Previous LTV'
                            : 'Next LTV'
            }
            placement="top"
            hasArrow
            isDisabled={!isConstraintViolation && !isAtLimit}
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
            minW={direction === 'left' ? '164px' : undefined}
        >
            <Box
                as="button"
                onClick={(e: React.MouseEvent) => {
                    e.stopPropagation()
                    if (canMoveDir && !isAtLimit) {
                        onArrowClick(direction)
                    }
                }}
                bg="transparent"
                border="none"
                cursor={isAtLimit || isConstraintViolation ? "not-allowed" : "pointer"}
                p={2}
                _hover={!isAtLimit && !isConstraintViolation ? { opacity: 0.8 } : {}}
                display="flex"
                flexDirection="column"
                alignItems="center"
                aria-label={direction === 'left' ? 'Previous LTV' : 'Next LTV'}
                pointerEvents="auto"
                opacity={isConstraintViolation ? 0.3 : (isAtLimit ? 0.5 : 1)}
                position="relative"
            >
                <ChevronIcon
                    color={isConstraintViolation ? "red.400" : PRIMARY_PURPLE}
                    boxSize={6}
                    style={{
                        filter: isConstraintViolation
                            ? 'drop-shadow(0 0 8px rgba(248, 113, 113, 0.4))'
                            : 'drop-shadow(0 0 8px rgba(155, 220, 79, 0.6))',
                    }}
                />
                {/* Warning icon for constraint violation only */}
                {isConstraintViolation && (
                    <Box
                        position="absolute"
                        top="-4px"
                        {...(direction === 'left' ? { right: '-4px' } : { left: '-4px' })}
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
}
