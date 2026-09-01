import React, { useEffect, useState } from 'react'
import { Box, Text, HStack, VStack } from '@chakra-ui/react'
import { keyframes } from '@emotion/react'
import { m, AnimatePresence } from 'framer-motion'
import { useActivityDetection, formatIdleTime } from './hooks/useActivityDetection'
import { useDittoSpeechBox } from './hooks/useDittoSpeechBox'
import { useProtocolUpdates } from './hooks/useProtocolUpdates'

import { FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'

const MotionBox = m(Box)

const waveKeyframes = keyframes`
    0% { transform: rotate(0deg); }
    10% { transform: rotate(14deg); }
    20% { transform: rotate(-8deg); }
    30% { transform: rotate(14deg); }
    40% { transform: rotate(-4deg); }
    50% { transform: rotate(10deg); }
    60% { transform: rotate(0deg); }
    100% { transform: rotate(0deg); }
`

interface ReturnWelcomeProps {
    onDismiss?: () => void
}

/**
 * Welcome back message shown when user returns after being away
 */
export const ReturnWelcome: React.FC<ReturnWelcomeProps> = ({ onDismiss }) => {
    const [showMessage, setShowMessage] = useState(false)
    const [awayDuration, setAwayDuration] = useState(0)
    const { toggleSpeechBox, isOpen } = useDittoSpeechBox()
    const { unreadCount, idleGains } = useProtocolUpdates()

    const { hasReturned, isIdle } = useActivityDetection({
        returnThreshold: 5 * 60 * 1000, // 5 minutes
        onReturn: (duration) => {
            setAwayDuration(duration)
            setShowMessage(true)
        },
    })

    // Auto-dismiss after 5 seconds
    useEffect(() => {
        if (showMessage) {
            const timer = setTimeout(() => {
                setShowMessage(false)
                onDismiss?.()
            }, 5000)
            return () => clearTimeout(timer)
        }
    }, [showMessage, onDismiss])

    // Generate contextual message
    const getMessage = () => {
        const duration = formatIdleTime(awayDuration)

        if (idleGains) {
            return `Welcome back! You earned $${idleGains.revenueAccumulated.toFixed(2)} while you were away.`
        }

        if (unreadCount > 0) {
            return `Welcome back! You have ${unreadCount} new update${unreadCount > 1 ? 's' : ''} to check.`
        }

        if (awayDuration > 60 * 60 * 1000) { // More than 1 hour
            return `Welcome back! It's been ${duration}. Your positions are still earning.`
        }

        return `Welcome back! 👋`
    }

    // The welcome bubble is a real control (it opens Ditto), so it must be
    // operable from the keyboard as well as the mouse.
    const handleActivate = () => {
        setShowMessage(false)
        toggleSpeechBox()
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleActivate()
        }
    }

    return (
        <AnimatePresence>
            {showMessage && !isOpen && (
                <MotionBox
                    initial={{ opacity: 0, y: 20, scale: 0.9 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -10, scale: 0.95 }}
                    transition={{ type: 'spring', stiffness: 300, damping: 25 }}
                    position="fixed"
                    bottom="140px"
                    left="20px"
                    zIndex={10001}
                    cursor="pointer"
                    role="button"
                    tabIndex={0}
                    aria-label="Open Ditto"
                    onClick={handleActivate}
                    onKeyDown={handleKeyDown}
                    _focus={FOCUS_STYLES.ring}
                    _focusVisible={FOCUS_STYLES.ring}
                >
                    <Box
                        bg={SEMANTIC_COLORS.bgTertiary}
                        border="1px solid"
                        borderColor={SEMANTIC_COLORS.borderStrong}
                        borderRadius={0}
                        p={3}
                        maxW="260px"
                        
                    >
                        <HStack spacing={3} align="flex-start">
                            <Box
                                fontSize="xl"
                                animation={`${waveKeyframes} 2s ease-in-out`}
                                transformOrigin="70% 70%"
                            >
                                👋
                            </Box>
                            <VStack align="stretch" spacing={1} flex={1}>
                                <Text fontSize="sm" color={SEMANTIC_COLORS.textPrimary} fontWeight="medium">
                                    {getMessage()}
                                </Text>
                                <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                                    Click to open Ditto
                                </Text>
                            </VStack>
                        </HStack>

                        {/* Progress bar for auto-dismiss */}
                        <Box
                            position="absolute"
                            bottom={0}
                            left={0}
                            right={0}
                            h="2px"
                            borderRadius={0}
                            overflow="hidden"
                        >
                            {/* Countdown bar: animate scaleX (GPU-composited) instead of
                                width so the shrink never triggers layout. transformOrigin
                                "left" makes it collapse toward the left edge, identical to
                                the original 100%→0% width animation. */}
                            <MotionBox
                                initial={{ scaleX: 1 }}
                                animate={{ scaleX: 0 }}
                                transition={{ duration: 5, ease: 'linear' }}
                                w="100%"
                                h="100%"
                                transformOrigin="left"
                                bg={`linear-gradient(to right, ${SEMANTIC_COLORS.primary}, ${SEMANTIC_COLORS.info})`}
                            />
                        </Box>
                    </Box>

                    {/* Arrow pointing to Ditto */}
                    <Box
                        position="absolute"
                        bottom="-8px"
                        left="40px"
                        width={0}
                        height={0}
                        borderLeft="8px solid transparent"
                        borderRight="8px solid transparent"
                        borderTop={`8px solid ${SEMANTIC_COLORS.bgTertiary}`}
                    />
                </MotionBox>
            )}
        </AnimatePresence>
    )
}

/**
 * Idle indicator shown when user has been inactive
 */
export const IdleIndicator: React.FC = () => {
    const { isIdle, idleTime } = useActivityDetection({
        idleThreshold: 60000, // 1 minute
    })
    const { isOpen } = useDittoSpeechBox()

    if (!isIdle || isOpen) return null

    return (
        <AnimatePresence>
            <MotionBox
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.5 }}
                position="fixed"
                bottom="100px"
                left="20px"
                zIndex={9998}
            >
                <Text fontSize="xs" color={SEMANTIC_COLORS.textTertiary} fontStyle="italic">
                    💤 Idle for {formatIdleTime(idleTime)}
                </Text>
            </MotionBox>
        </AnimatePresence>
    )
}

