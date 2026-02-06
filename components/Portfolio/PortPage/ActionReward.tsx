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
import { motion, AnimatePresence } from 'framer-motion'

const MotionBox = motion(Box)

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
                        bg="gray.800"
                        border="2px solid"
                        borderColor="cyan.500"
                        borderRadius="lg"
                        p={6}
                        minW="320px"
                        boxShadow="0 0 20px rgba(111, 255, 194, 0.3)"
                        position="relative"
                        _before={{
                            content: '""',
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            background: 'linear-gradient(135deg, rgba(111, 255, 194, 0.1) 0%, rgba(138, 43, 226, 0.1) 100%)',
                            borderRadius: 'lg',
                            pointerEvents: 'none',
                        }}
                    >
                        <VStack spacing={4} align="stretch" position="relative" zIndex={1}>
                            <HStack justify="space-between" align="flex-start">
                                <VStack spacing={1} align="flex-start" flex={1}>
                                    <Text
                                        fontSize="xs"
                                        color="gray.400"
                                        fontFamily="mono"
                                        textTransform="uppercase"
                                        letterSpacing="wide"
                                    >
                                        Action Reward
                                    </Text>
                                    <Text
                                        fontSize="3xl"
                                        fontWeight="bold"
                                        color="cyan.400"
                                        fontFamily="mono"
                                        textShadow="0 0 10px rgba(111, 255, 194, 0.5)"
                                    >
                                        +{reward.points.toFixed(1)} Points
                                    </Text>
                                </VStack>
                                <IconButton
                                    aria-label="Close"
                                    icon={<CloseIcon />}
                                    size="sm"
                                    variant="ghost"
                                    color="gray.400"
                                    _hover={{ color: 'cyan.400' }}
                                    onClick={() => {
                                        setIsVisible(false)
                                        setTimeout(onClose, 300)
                                    }}
                                />
                            </HStack>

                            <Box
                                p={3}
                                bg="gray.700"
                                borderRadius="md"
                                border="1px solid"
                                borderColor="gray.600"
                            >
                                <Text
                                    fontSize="sm"
                                    color="gray.300"
                                    fontFamily="mono"
                                    lineHeight="1.6"
                                >
                                    {reward.narrative}
                                </Text>
                            </Box>

                            {reward.yieldIncrease && reward.yieldIncrease > 0 && (
                                <HStack
                                    p={3}
                                    bg="green.900"
                                    borderRadius="md"
                                    border="1px solid"
                                    borderColor="green.500"
                                >
                                    <Text fontSize="sm" color="green.400" fontFamily="mono">
                                        Yield Increase:
                                    </Text>
                                    <Text
                                        fontSize="lg"
                                        fontWeight="bold"
                                        color="green.300"
                                        fontFamily="mono"
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
