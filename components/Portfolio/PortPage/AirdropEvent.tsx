import React, { useEffect, useState } from 'react'
import {
    Box,
    VStack,
    HStack,
    Text,
    IconButton,
    Button,
} from '@chakra-ui/react'
import { CloseIcon } from '@chakra-ui/icons'
import { m, AnimatePresence } from 'framer-motion'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import usePortState from '@/persisted-state/usePortState'

const MotionBox = m(Box)

interface AirdropEventProps {
    amount: number
    onClose: () => void
}

export const AirdropEvent: React.FC<AirdropEventProps> = ({ amount, onClose }) => {
    const [isVisible, setIsVisible] = useState(true)
    const { setPortState, portState } = usePortState()

    useEffect(() => {
        // Record airdrop in history
        const airdropEntry = {
            timestamp: Date.now(),
            amount,
            mbrnAmount: amount.toFixed(6),
        }
        const updatedHistory = [...(portState.airdropHistory || []), airdropEntry]
        setPortState({
            airdropHistory: updatedHistory,
            lastAirdropTime: Date.now(),
        })
    }, [amount, setPortState, portState])

    const handleClose = () => {
        setIsVisible(false)
        setTimeout(onClose, 500) // Wait for animation
    }

    return (
        <AnimatePresence>
            {isVisible && (
                <MotionBox
                    position="fixed"
                    top="50%"
                    left="50%"
                    transform="translate(-50%, -50%)"
                    zIndex={10000}
                    initial={{ opacity: 0, scale: 0.5, rotate: -180 }}
                    animate={{ opacity: 1, scale: 1, rotate: 0 }}
                    exit={{ opacity: 0, scale: 0.5, rotate: 180 }}
                    transition={{ duration: 0.6, type: 'spring', bounce: 0.4 }}
                >
                    <Box
                        bg={SEMANTIC_COLORS.bgSecondary}
                        border="1px solid"
                        borderColor={SEMANTIC_COLORS.warning}
                        borderRadius={0}
                        p={SPACING.xl}
                        minW="400px"
                        position="relative"
                        overflow="hidden"
                    >
                        <VStack spacing={SPACING.lg} align="stretch" position="relative" zIndex={1}>
                            <HStack justify="flex-end">
                                <IconButton
                                    aria-label="Close"
                                    icon={<CloseIcon />}
                                    size="sm"
                                    variant="ghost"
                                    color={SEMANTIC_COLORS.textSecondary}
                                    transition={TRANSITIONS.colors}
                                    _hover={HOVER_EFFECTS.brighten}
                                    _focus={FOCUS_STYLES.ring}
                                    onClick={handleClose}
                                />
                            </HStack>

                            <VStack spacing={SPACING.base}>
                                <MotionBox
                                    animate={{
                                        scale: [1, 1.2, 1],
                                        rotate: [0, 10, -10, 0],
                                    }}
                                    transition={{
                                        duration: 2,
                                        repeat: Infinity,
                                        ease: 'easeInOut',
                                    }}
                                >
                                    <Text
                                        fontSize="6xl"
                                        fontWeight={TYPOGRAPHY.bold}
                                        color={SEMANTIC_COLORS.warning}
                                        fontFamily={TYPOGRAPHY.fontMono}
                                    >
                                        🎁
                                    </Text>
                                </MotionBox>

                                <Text
                                    fontSize="2xl"
                                    fontWeight={TYPOGRAPHY.bold}
                                    color={SEMANTIC_COLORS.warning}
                                    fontFamily={TYPOGRAPHY.fontMono}
                                    textTransform="uppercase"
                                    letterSpacing="wide"
                                    textAlign="center"
                                >
                                    Random Airdrop!
                                </Text>

                                <Box
                                    p={SPACING.lg}
                                    bg={SEMANTIC_COLORS.bgTertiary}
                                    borderRadius={0}
                                    border="1px solid"
                                    borderColor={SEMANTIC_COLORS.warning}
                                    minW="100%"
                                >
                                    <VStack spacing={SPACING.sm}>
                                        <Text
                                            fontSize="sm"
                                            color={SEMANTIC_COLORS.warning}
                                            fontFamily={TYPOGRAPHY.fontMono}
                                            textTransform="uppercase"
                                        >
                                            You Received
                                        </Text>
                                        <Text
                                            fontSize="4xl"
                                            fontWeight={TYPOGRAPHY.bold}
                                            color={SEMANTIC_COLORS.textPrimary}
                                            fontFamily={TYPOGRAPHY.fontMono}
                                            sx={{ fontVariantNumeric: 'tabular-nums' }}
                                        >
                                            {amount.toFixed(6)} MBRN
                                        </Text>
                                    </VStack>
                                </Box>

                                <Text
                                    fontSize="xs"
                                    color={SEMANTIC_COLORS.textSecondary}
                                    fontFamily={TYPOGRAPHY.fontMono}
                                    textAlign="center"
                                    maxW="300px"
                                >
                                    A rare event! Your continued participation in the system has been rewarded.
                                </Text>

                                <Button
                                    size="lg"
                                    onClick={handleClose}
                                    fontFamily={TYPOGRAPHY.fontMono}
                                    fontWeight={TYPOGRAPHY.bold}
                                    bg={SEMANTIC_COLORS.warning}
                                    color={SEMANTIC_COLORS.bgPrimary}
                                    borderRadius={0}
                                    transition={TRANSITIONS.colors}
                                    _hover={{ opacity: 0.9 }}
                                    _focus={FOCUS_STYLES.ring}
                                >
                                    Claim & Continue
                                </Button>
                            </VStack>
                        </VStack>
                    </Box>
                </MotionBox>
            )}
        </AnimatePresence>
    )
}

// Hook to manage airdrop events
export const useAirdropEvent = () => {
    const [airdropAmount, setAirdropAmount] = useState<number | null>(null)
    const { portState } = usePortState()

    const checkAirdrop = (triggerAction: boolean = false) => {
        // Variable-ratio reinforcement: 1-2% chance
        const probability = triggerAction ? 0.02 : 0.01 // Higher chance on action
        const shouldTrigger = Math.random() < probability

        // Don't trigger if airdrop happened recently (within last hour)
        const lastAirdrop = portState.lastAirdropTime
        const now = Date.now()
        const oneHour = 60 * 60 * 1000
        const recentAirdrop = lastAirdrop && now - lastAirdrop < oneHour

        if (shouldTrigger && !recentAirdrop) {
            // Random amount between 0.1 and 1.0 MBRN
            const amount = 0.1 + Math.random() * 0.9
            setAirdropAmount(amount)
            return true
        }
        return false
    }

    const closeAirdrop = () => {
        setAirdropAmount(null)
    }

    return {
        airdropAmount,
        checkAirdrop,
        closeAirdrop,
    }
}
