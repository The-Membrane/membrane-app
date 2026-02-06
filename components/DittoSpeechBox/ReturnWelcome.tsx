import React, { useEffect, useState } from 'react'
import { Box, Text, HStack, VStack } from '@chakra-ui/react'
import { keyframes } from '@emotion/react'
import { motion, AnimatePresence } from 'framer-motion'
import { useActivityDetection, formatIdleTime } from './hooks/useActivityDetection'
import { useDittoSpeechBox } from './hooks/useDittoSpeechBox'
import { useProtocolUpdates } from './hooks/useProtocolUpdates'

const MotionBox = motion(Box)

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
                    onClick={() => {
                        setShowMessage(false)
                        toggleSpeechBox()
                    }}
                >
                    <Box
                        bg="#23252B"
                        border="1px solid"
                        borderColor="#6943FF40"
                        borderRadius="lg"
                        p={3}
                        maxW="260px"
                        boxShadow="0 4px 20px rgba(0,0,0,0.4), 0 0 30px rgba(105, 67, 255, 0.2)"
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
                                <Text fontSize="sm" color="#F5F5F5" fontWeight="medium">
                                    {getMessage()}
                                </Text>
                                <Text fontSize="xs" color="#F5F5F580">
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
                            borderBottomRadius="lg"
                            overflow="hidden"
                        >
                            <MotionBox
                                initial={{ width: '100%' }}
                                animate={{ width: '0%' }}
                                transition={{ duration: 5, ease: 'linear' }}
                                h="100%"
                                bg="linear-gradient(to right, #6943FF, #3BE5E5)"
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
                        borderTop="8px solid #23252B"
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
                <Text fontSize="xs" color="#F5F5F540" fontStyle="italic">
                    💤 Idle for {formatIdleTime(idleTime)}
                </Text>
            </MotionBox>
        </AnimatePresence>
    )
}

