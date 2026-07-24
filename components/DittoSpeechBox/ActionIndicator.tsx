import React from 'react'
import { Box, Text, Tooltip } from '@chakra-ui/react'
import { keyframes } from '@emotion/react'
import { m } from 'framer-motion'

const MotionBox = m(Box)

const pulseGlow = keyframes`
    0% {
        box-shadow: 0 0 0 0 rgba(155, 220, 79, 0.6);
    }
    70% {
        box-shadow: 0 0 0 10px rgba(155, 220, 79, 0);
    }
    100% {
        box-shadow: 0 0 0 0 rgba(155, 220, 79, 0);
    }
`

const breathe = keyframes`
    0%, 100% {
        transform: scale(1);
        opacity: 1;
    }
    50% {
        transform: scale(1.05);
        opacity: 0.9;
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
        fontSize="14px"
        fontWeight="black"
        color="white"
        lineHeight="1"
        textShadow="0 1px 2px rgba(0,0,0,0.3)"
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

    return (
        <Tooltip
            label={displayTooltip}
            placement="top"
            hasArrow
            bg="#23252B"
            color="#ece6d8"
            fontSize="xs"
            px={3}
            py={2}
            borderRadius="md"
            border="1px solid"
            borderColor="#9bdc4f40"
        >
            <Box
                position="relative"
                zIndex={10}
                cursor={onClick ? 'pointer' : 'default'}
                onClick={onClick}
                transition="transform 0.2s ease-in-out"
                _hover={{
                    transform: 'scale(1.3)',
                }}
            >
                {/* Outer glow ring */}
                <Box
                    position="absolute"
                    w="24px"
                    h="24px"
                    borderRadius="full"
                    animation={`${pulseGlow} 2s ease-in-out infinite`}
                    top="50%"
                    left="50%"
                    transform="translate(-50%, -50%)"
                />

                {/* Inner badge */}
                <Box
                    w="22px"
                    h="22px"
                    borderRadius="full"
                    bg="linear-gradient(135deg, #9bdc4f 0%, #46d39a 100%)"
                    border="2px solid #23252B"
                    animation={`${breathe} 2s ease-in-out infinite`}
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    boxShadow="0 0 12px rgba(155, 220, 79, 0.6)"
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
