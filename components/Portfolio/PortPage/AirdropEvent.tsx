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
import { motion, AnimatePresence } from 'framer-motion'
import usePortState from '@/persisted-state/usePortState'

const MotionBox = motion(Box)

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
                        bg="gray.900"
                        border="3px solid"
                        borderColor="yellow.400"
                        borderRadius="xl"
                        p={8}
                        minW="400px"
                        boxShadow="0 0 40px rgba(255, 193, 7, 0.5)"
                        position="relative"
                        overflow="hidden"
                        _before={{
                            content: '""',
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            right: 0,
                            bottom: 0,
                            background: 'radial-gradient(circle, rgba(255, 193, 7, 0.2) 0%, transparent 70%)',
                            pointerEvents: 'none',
                        }}
                    >
                        <VStack spacing={6} align="stretch" position="relative" zIndex={1}>
                            <HStack justify="flex-end">
                                <IconButton
                                    aria-label="Close"
                                    icon={<CloseIcon />}
                                    size="sm"
                                    variant="ghost"
                                    color="gray.400"
                                    _hover={{ color: 'yellow.400' }}
                                    onClick={handleClose}
                                />
                            </HStack>

                            <VStack spacing={4}>
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
                                        fontWeight="bold"
                                        color="yellow.400"
                                        textShadow="0 0 20px rgba(255, 193, 7, 0.8)"
                                        fontFamily="mono"
                                    >
                                        🎁
                                    </Text>
                                </MotionBox>

                                <Text
                                    fontSize="2xl"
                                    fontWeight="bold"
                                    color="yellow.400"
                                    fontFamily="mono"
                                    textTransform="uppercase"
                                    letterSpacing="wide"
                                    textAlign="center"
                                >
                                    Random Airdrop!
                                </Text>

                                <Box
                                    p={6}
                                    bg="yellow.900"
                                    borderRadius="lg"
                                    border="2px solid"
                                    borderColor="yellow.500"
                                    minW="100%"
                                >
                                    <VStack spacing={2}>
                                        <Text
                                            fontSize="sm"
                                            color="yellow.300"
                                            fontFamily="mono"
                                            textTransform="uppercase"
                                        >
                                            You Received
                                        </Text>
                                        <Text
                                            fontSize="4xl"
                                            fontWeight="bold"
                                            color="yellow.200"
                                            fontFamily="mono"
                                            textShadow="0 0 10px rgba(255, 193, 7, 0.5)"
                                        >
                                            {amount.toFixed(6)} MBRN
                                        </Text>
                                    </VStack>
                                </Box>

                                <Text
                                    fontSize="xs"
                                    color="gray.400"
                                    fontFamily="mono"
                                    textAlign="center"
                                    maxW="300px"
                                >
                                    A rare event! Your continued participation in the system has been rewarded.
                                </Text>

                                <Button
                                    colorScheme="yellow"
                                    size="lg"
                                    onClick={handleClose}
                                    fontFamily="mono"
                                    fontWeight="bold"
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
