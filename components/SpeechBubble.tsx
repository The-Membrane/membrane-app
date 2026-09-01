import React from 'react'
import { Box, Text } from '@chakra-ui/react'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { FOCUS_STYLES } from '@/config/transitions'

// --- Positioning constants (relative to the global DittoHologram anchor) ---
// The hologram sits ~35% up from the bottom; the bubble floats one hologram
// height plus a small gap above it, horizontally centered over its head.
const HOLOGRAM_VERTICAL_ANCHOR = '35%'
const HOLOGRAM_HEIGHT = '96px'
const BUBBLE_GAP = '16px'
const HOLOGRAM_HEAD_OFFSET = '69%'

const DEFAULT_BUBBLE_BOTTOM = `calc(${HOLOGRAM_VERTICAL_ANCHOR} + ${HOLOGRAM_HEIGHT} + ${BUBBLE_GAP})`

// Bubble surface + tail color (kept as the neutral chrome grey it already used).
const BUBBLE_BG = '#23252B'

interface SpeechBubbleProps {
    message: string
    isVisible?: boolean
    position?: {
        bottom?: string
        left?: string
        right?: string
        top?: string
    }
    maxW?: string
    minW?: string
    onDismiss?: () => void
}

export const SpeechBubble: React.FC<SpeechBubbleProps> = ({
    message,
    isVisible = true,
    position = { bottom: DEFAULT_BUBBLE_BOTTOM, left: HOLOGRAM_HEAD_OFFSET },
    maxW = '300px',
    minW = '200px',
    onDismiss,
}) => {
    if (!isVisible) return null

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (!onDismiss) return
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onDismiss()
        }
    }

    return (
        <Box
            position="absolute"
            bottom={position.bottom}
            left={position.left}
            right={position.right}
            top={position.top}
            transform={position.left === HOLOGRAM_HEAD_OFFSET ? 'translateX(-50%)' : undefined}
            bg={BUBBLE_BG}
            color={SEMANTIC_COLORS.textPrimary}
            px={4}
            py={3}
            borderRadius={0}
            maxW={maxW}
            minW={minW}
            boxShadow="0 4px 12px rgba(0,0,0,0.5)"
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderStrong}
            zIndex={1}
            opacity={isVisible ? 1 : 0}
            transition="opacity 0.3s ease-in-out"
            cursor={onDismiss ? 'pointer' : 'default'}
            onClick={onDismiss}
            role={onDismiss ? 'button' : undefined}
            tabIndex={onDismiss ? 0 : undefined}
            aria-label={onDismiss ? 'Dismiss message' : undefined}
            onKeyDown={handleKeyDown}
            _focus={onDismiss ? FOCUS_STYLES.ring : undefined}
            _after={{
                content: '""',
                position: 'absolute',
                bottom: '-8px',
                left: '38%',
                transform: 'translateX(-50%)',
                width: 0,
                height: 0,
                borderLeft: '8px solid transparent',
                borderRight: '8px solid transparent',
                borderTop: `8px solid ${BUBBLE_BG}`,
            }}
            _before={{
                content: '""',
                position: 'absolute',
                bottom: '-9px',
                left: '38%',
                transform: 'translateX(-50%)',
                width: 0,
                height: 0,
                borderLeft: '9px solid transparent',
                borderRight: '9px solid transparent',
                borderTop: `9px solid ${SEMANTIC_COLORS.borderStrong}`,
            }}
        >
            <Text
                fontFamily="mono"
                fontSize="sm"
                lineHeight="1.4"
                color={SEMANTIC_COLORS.textPrimary}
            >
                {message}
            </Text>
        </Box>
    )
}
