import React from 'react'
import { Box, Text, Tooltip } from '@chakra-ui/react'
import { keyframes } from '@emotion/react'
import { m } from 'framer-motion'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

const MotionBox = m(Box)

// Living Typeface: attention is signalled by an opacity breath, never by a
// scale pulse or a box-shadow glow ring.
const breathe = keyframes`
    0%, 100% {
        opacity: 1;
    }
    50% {
        opacity: 0.6;
    }
`

interface ActionIndicatorProps {
    hasActions: boolean
    tooltip?: string | null
    count?: number
    onClick?: () => void
}

/**
 * Visual indicator shown on Ditto when actions are available on the current page.
 * Shows a pulsing exclamation mark with a glow effect and optional tooltip.
 */
// Static icon element hoisted to module scope so it isn't reallocated on every render.
const ACTION_ICON = (
    <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        fontWeight={TYPOGRAPHY.bold}
        color={SEMANTIC_COLORS.bgPrimary}
        lineHeight="1"
    >
        !
    </Text>
)

export const ActionIndicator: React.FC<ActionIndicatorProps> = ({
    hasActions,
    tooltip,
    count,
    onClick,
}) => {
    if (!hasActions) return null

    const displayTooltip = tooltip || 'Actions available'

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (!onClick) return
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onClick()
        }
    }

    return (
        <Tooltip
            label={displayTooltip}
            placement="top"
            hasArrow
            bg={SEMANTIC_COLORS.bgTertiary}
            color={SEMANTIC_COLORS.textPrimary}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            px={SPACING.md}
            py={SPACING.sm}
            borderRadius={0}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderStrong}
        >
            <Box
                position="relative"
                zIndex={10}
                cursor={onClick ? 'pointer' : 'default'}
                onClick={onClick}
                onKeyDown={onClick ? handleKeyDown : undefined}
                role={onClick ? 'button' : undefined}
                tabIndex={onClick ? 0 : undefined}
                aria-label={onClick ? displayTooltip : undefined}
                transition={TRANSITIONS.colors}
                _hover={onClick ? HOVER_EFFECTS.brighten : undefined}
                _focus={onClick ? FOCUS_STYLES.ring : undefined}
                _focusVisible={onClick ? FOCUS_STYLES.ring : undefined}
            >
                {/* Badge */}
                <Box
                    w="22px"
                    h="22px"
                    borderRadius="full"
                    bg={SEMANTIC_COLORS.primary}
                    border="2px solid"
                    borderColor={SEMANTIC_COLORS.bgPrimary}
                    animation={`${breathe} 2s ease-in-out infinite`}
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                >
                    {ACTION_ICON}
                </Box>
            </Box>
        </Tooltip>
    )
}

/**
 * Subtle glow effect for the Ditto image when actions are available.
 * This creates a soft ambient glow around Ditto.
 */
export const DittoActionGlow: React.FC<{ hasActions: boolean }> = ({ hasActions }) => {
    if (!hasActions) return null

    return (
        <MotionBox
            position="absolute"
            inset="-20px"
            borderRadius="full"
            pointerEvents="none"
            initial={{ opacity: 0 }}
            animate={{
                opacity: [0.3, 0.5, 0.3],
            }}
            transition={{
                duration: 2,
                repeat: Infinity,
                ease: 'easeInOut',
            }}
            bg="radial-gradient(circle, rgba(155, 220, 79, 0.3) 0%, rgba(70, 211, 154, 0.1) 50%, transparent 70%)"
        />
    )
}
