import React from 'react'
import { Box, Text } from '@chakra-ui/react'
import { m } from 'framer-motion'
import { PRIMARY_PURPLE, CURRENT_LTV_COLOR } from './LTVCarouselConstants'

interface LTVCarouselNotchProps {
    ltv: number
    // FP (no-many-boolean-props): isSelected/isCurrent/isHovered/hasData/showLabel are
    // independent facts sourced from separate state (click selection, position LTV,
    // hover position, data presence) that can combine in any combination, not a
    // mutually-exclusive variant — see getNotchState in LTVNumberLineCarousel.tsx.
    isSelected: boolean
    isCurrent: boolean
    isHovered: boolean
    hasData: boolean
    showLabel: boolean
    onSelect: (ltv: number) => void
    onHover: (ltv: number | null) => void
}

// A single notch on the LTV number line, including its (min/max only) label.
export const LTVCarouselNotch: React.FC<LTVCarouselNotchProps> = ({
    ltv,
    isSelected,
    isCurrent,
    isHovered,
    hasData,
    showLabel,
    onSelect,
    onHover,
}) => {
    const percent = Math.round(ltv * 100)

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
        notchColor = 'rgba(155, 220, 79, 0.3)'
        glowColor = 'transparent'
    }

    return (
        <Box
            data-ltv={ltv}
            position="relative"
            flex={1}
            display="flex"
            flexDirection="column"
            alignItems="center"
            cursor="pointer"
            onClick={() => onSelect(ltv)}
            onMouseEnter={() => onHover(ltv)}
            onMouseLeave={() => onHover(null)}
            style={{ minWidth: '2px' }}
        >
            {/* Notch */}
            <m.div
                animate={{
                    scaleY: notchHeight / 40,
                    opacity: hasData ? 1 : 0.5,
                }}
                transition={{ duration: 0.2 }}
                style={{
                    width: '2px',
                    height: '40px',
                    transformOrigin: 'bottom',
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
}
