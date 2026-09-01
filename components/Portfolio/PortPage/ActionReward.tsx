import React, { useEffect, useState } from 'react'
import {
    Box,
    VStack,
    HStack,
    Text,
    IconButton,
    useToast,
} from '@chakra-ui/react'
import { CloseIcon } from '@chakra-ui/icons'
import { m, AnimatePresence } from 'framer-motion'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

const MotionBox = m(Box)

export interface ActionRewardData {
    points: number
    narrative: string
    yieldIncrease?: number
}

interface ActionRewardProps {
    reward: ActionRewardData | null
    onClose: () => void
}

const narrativeMessages = [
    'Your action strengthened the corridor in the Disco.',
    'The Transmuter flows more efficiently with your contribution.',
    'Your Manic vault position grows stronger.',
    'System stability increases with your participation.',
    'The flywheel spins faster with your action.',
]

export const ActionReward: React.FC<ActionRewardProps> = ({ reward, onClose }) => {
    const [isVisible, setIsVisible] = useState(false)

    useEffect(() => {
        if (reward) {
            setIsVisible(true)
            const timer = setTimeout(() => {
                setIsVisible(false)
                setTimeout(onClose, 300) // Wait for animation to complete
            }, 4000) // Auto-dismiss after 4 seconds

            return () => clearTimeout(timer)
        }
    }, [reward, onClose])

    if (!reward) return null

    return (
        <AnimatePresence>
            {isVisible && (
                <MotionBox
                    position="fixed"
                    top="20%"
                    right="20px"
                    zIndex={9999}
                    initial={{ opacity: 0, x: 100, scale: 0.8 }}
                    animate={{ opacity: 1, x: 0, scale: 1 }}
                    exit={{ opacity: 0, x: 100, scale: 0.8 }}
                    transition={{ duration: 0.3, type: 'spring' }}
                >
                    <Box
                        bg={SEMANTIC_COLORS.bgSecondary}
                        border="1px solid"
                        borderColor={SEMANTIC_COLORS.borderMedium}
                        borderRadius={0}
                        p={SPACING.lg}
                        minW="320px"
                        position="relative"
                    >
                        <VStack spacing={SPACING.base} align="stretch" position="relative" zIndex={1}>
                            <HStack justify="space-between" align="flex-start">
                                <VStack spacing={SPACING.xs} align="flex-start" flex={1}>
                                    <Text
                                        fontSize="xs"
                                        color={SEMANTIC_COLORS.textSecondary}
                                        fontFamily={TYPOGRAPHY.fontMono}
                                        textTransform="uppercase"
                                        letterSpacing="wide"
                                    >
                                        Action Reward
                                    </Text>
                                    <Text
                                        fontSize="3xl"
                                        fontWeight={TYPOGRAPHY.bold}
                                        color={SEMANTIC_COLORS.info}
                                        fontFamily={TYPOGRAPHY.fontMono}
                                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                                    >
                                        +{reward.points.toFixed(1)} Points
                                    </Text>
                                </VStack>
                                <IconButton
                                    aria-label="Close"
                                    icon={<CloseIcon />}
                                    size="sm"
                                    variant="ghost"
                                    color={SEMANTIC_COLORS.textSecondary}
                                    transition={TRANSITIONS.colors}
                                    _hover={HOVER_EFFECTS.brighten}
                                    _focus={FOCUS_STYLES.ring}
                                    onClick={() => {
                                        setIsVisible(false)
                                        setTimeout(onClose, 300)
                                    }}
                                />
                            </HStack>

                            <Box
                                p={SPACING.md}
                                bg={SEMANTIC_COLORS.bgTertiary}
                                borderRadius={0}
                                border="1px solid"
                                borderColor={SEMANTIC_COLORS.borderMedium}
                            >
                                <Text
                                    fontSize="sm"
                                    color={SEMANTIC_COLORS.textPrimary}
                                    fontFamily={TYPOGRAPHY.fontMono}
                                    lineHeight="1.6"
                                >
                                    {reward.narrative}
                                </Text>
                            </Box>

                            {reward.yieldIncrease && reward.yieldIncrease > 0 && (
                                <HStack
                                    p={SPACING.md}
                                    bg={SEMANTIC_COLORS.bgTertiary}
                                    borderRadius={0}
                                    border="1px solid"
                                    borderColor={SEMANTIC_COLORS.success}
                                >
                                    <Text fontSize="sm" color={SEMANTIC_COLORS.success} fontFamily={TYPOGRAPHY.fontMono}>
                                        Yield Increase:
                                    </Text>
                                    <Text
                                        fontSize="lg"
                                        fontWeight={TYPOGRAPHY.bold}
                                        color={SEMANTIC_COLORS.success}
                                        fontFamily={TYPOGRAPHY.fontMono}
                                        sx={{ fontVariantNumeric: 'tabular-nums' }}
                                    >
                                        +{reward.yieldIncrease.toFixed(2)}%
                                    </Text>
                                </HStack>
                            )}
                        </VStack>
                    </Box>
                </MotionBox>
            )}
        </AnimatePresence>
    )
}

// Hook to trigger action rewards
export const useActionReward = () => {
    const [currentReward, setCurrentReward] = useState<ActionRewardData | null>(null)
    const toast = useToast()

    const triggerReward = (points: number, narrative?: string, yieldIncrease?: number) => {
        const reward: ActionRewardData = {
            points,
            narrative: narrative || narrativeMessages[Math.floor(Math.random() * narrativeMessages.length)],
            yieldIncrease,
        }
        setCurrentReward(reward)
    }

    const closeReward = () => {
        setCurrentReward(null)
    }

    return {
        currentReward,
        triggerReward,
        closeReward,
    }
}
