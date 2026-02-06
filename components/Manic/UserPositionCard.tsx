import React, { useMemo } from 'react'
import {
    Box,
    Card,
    VStack,
    HStack,
    Text,
    Button,
    Progress,
    Tooltip,
    IconButton,
} from '@chakra-ui/react'
import { InfoIcon } from '@chakra-ui/icons'
import { motion, AnimatePresence } from 'framer-motion'
import { DepositCard } from './DepositModal'
import { BoostBreakdown } from './BoostBreakdown'

const MotionBox = motion(Box)
const MotionVStack = motion(VStack)

interface UserPositionCardProps {
    hasPosition: boolean
    collateralAmount: number
    debtAmount: number
    userAPR: number
    baseAPR: number
    isDepositOpen: boolean
    onDepositClick: () => void
    onDeposit: (amount: string) => void
    onCloseDeposit: () => void
}

export const UserPositionCard: React.FC<UserPositionCardProps> = ({
    hasPosition,
    collateralAmount,
    debtAmount,
    userAPR,
    baseAPR,
    isDepositOpen,
    onDepositClick,
    onDeposit,
    onCloseDeposit,
}) => {
    // Calculate current loop level: collateral / (collateral - debt)
    const currentLoopLevel = useMemo(() => {
        if (!hasPosition || collateralAmount <= 0) return 1
        const equity = collateralAmount - debtAmount
        if (equity <= 0) return 10 // Max loop level if no equity
        return Math.min(collateralAmount / equity, 10)
    }, [hasPosition, collateralAmount, debtAmount])

    // Calculate current LTV for health indicator
    const currentLTV = useMemo(() => {
        if (!hasPosition || collateralAmount <= 0) return 0
        return (debtAmount / collateralAmount) * 100
    }, [hasPosition, collateralAmount, debtAmount])

    // Health indicator: Green < 60%, Yellow 60-80%, Red > 80%
    const healthColor = useMemo(() => {
        if (currentLTV < 60) return 'green.400'
        if (currentLTV < 80) return 'yellow.400'
        return 'red.400'
    }, [currentLTV])

    const healthLabel = useMemo(() => {
        if (currentLTV < 60) return 'Healthy'
        if (currentLTV < 80) return 'Moderate'
        return 'At Risk'
    }, [currentLTV])

    // Empty state - no position
    if (!hasPosition) {
        return (
            <MotionBox
                layout
                transition={{ duration: 0.3, ease: "easeInOut" }}
            >
                <Card
                    bg="gray.800"
                    borderColor="gray.600"
                    borderWidth="2px"
                    p={8}
                    w="100%"
                    overflow="hidden"
                >
                    <MotionVStack 
                        spacing={6} 
                        align="center"
                        layout
                        transition={{ duration: 0.3, ease: "easeInOut" }}
                    >
                        <VStack spacing={2}>
                            <AnimatePresence mode="wait">
                                {!isDepositOpen && (
                                    <MotionBox
                                        key="title"
                                        initial={{ opacity: 0, height: 0 }}
                                        animate={{ opacity: 1, height: "auto" }}
                                        exit={{ opacity: 0, height: 0 }}
                                        transition={{ duration: 0.2 }}
                                    >
                                        <Text
                                            fontSize="xl"
                                            fontWeight="bold"
                                            color="gray.400"
                                            fontFamily="mono"
                                        >
                                            No Position Found
                                        </Text>
                                    </MotionBox>
                                )}
                            </AnimatePresence>
                            <Text
                                fontSize="sm"
                                color="gray.500"
                                fontFamily="mono"
                                textAlign="center"
                            >
                                Deposit USDC to enable looping
                            </Text>
                        </VStack>

                        <AnimatePresence mode="wait">
                            {isDepositOpen ? (
                                <MotionBox 
                                    key="deposit-form"
                                    w="100%" 
                                    maxW="500px"
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: "auto" }}
                                    exit={{ opacity: 0, height: 0 }}
                                    transition={{ duration: 0.3, ease: "easeInOut" }}
                                >
                                    <DepositCard
                                        isOpen={isDepositOpen}
                                        onClose={onCloseDeposit}
                                        onDeposit={onDeposit}
                                        inline={true}
                                        hideUsdValue={true}
                                    />
                                </MotionBox>
                            ) : (
                                <MotionBox
                                    key="deposit-button"
                                    initial={{ opacity: 0, scale: 0.9 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.9 }}
                                    transition={{ duration: 0.2 }}
                                >
                                    <Button
                                        size="lg"
                                        colorScheme="cyan"
                                        bg="cyan.500"
                                        color="white"
                                        onClick={onDepositClick}
                                        fontFamily="mono"
                                        fontSize="lg"
                                        w="20%"
                                        minW="150px"
                                        _hover={{
                                            bg: 'cyan.400',
                                            transform: 'scale(1.02)',
                                        }}
                                    >
                                        Deposit USDC
                                    </Button>
                                </MotionBox>
                            )}
                        </AnimatePresence>
                    </MotionVStack>
                </Card>
            </MotionBox>
        )
    }

    // Has position - show position details
    return (
        <Card
            bg="gray.800"
            borderColor="cyan.600"
            borderWidth="2px"
            p={6}
            w="100%"
            boxShadow="0 0 20px rgba(0, 191, 255, 0.15)"
        >
            <VStack spacing={6} align="stretch">
                {/* Header */}
                <HStack justify="space-between" align="center">
                    <HStack spacing={2}>
                        <Text
                            fontSize="lg"
                            fontWeight="bold"
                            color="white"
                            fontFamily="mono"
                            textTransform="uppercase"
                        >
                            Your Position
                        </Text>
                        <Tooltip
                            label="Your current USDC looping position. Loop level shows how leveraged your position is."
                            fontSize="xs"
                            bg="gray.800"
                            color="#F5F5F5"
                            border="1px solid"
                            borderColor="cyan.500"
                            borderRadius="md"
                            p={3}
                            hasArrow
                        >
                            <IconButton
                                aria-label="Position Info"
                                icon={<InfoIcon />}
                                size="xs"
                                variant="ghost"
                                color="gray.400"
                                _hover={{ color: "cyan.400" }}
                                minW="auto"
                                w="auto"
                                h="auto"
                            />
                        </Tooltip>
                    </HStack>
                    <BoostBreakdown />
                </HStack>

                {/* Position Stats Grid */}
                <HStack spacing={6} w="100%" justify="space-between">
                    {/* Deposited Amount */}
                    <VStack align="start" spacing={1} flex={1}>
                        <Text
                            fontSize="xs"
                            color="gray.400"
                            fontFamily="mono"
                            textTransform="uppercase"
                        >
                            Deposited
                        </Text>
                        <Text
                            fontSize="2xl"
                            fontWeight="bold"
                            color="white"
                            fontFamily="mono"
                        >
                            {collateralAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC
                        </Text>
                    </VStack>

                    {/* Current Loop Level */}
                    <VStack align="start" spacing={1} flex={1}>
                        <Text
                            fontSize="xs"
                            color="gray.400"
                            fontFamily="mono"
                            textTransform="uppercase"
                        >
                            Loop Level
                        </Text>
                        <Text
                            fontSize="2xl"
                            fontWeight="bold"
                            color="cyan.400"
                            fontFamily="mono"
                        >
                            {currentLoopLevel.toFixed(1)}x
                        </Text>
                    </VStack>

                    {/* Current Net APR */}
                    <VStack align="start" spacing={1} flex={1}>
                        <Text
                            fontSize="xs"
                            color="gray.400"
                            fontFamily="mono"
                            textTransform="uppercase"
                        >
                            Net APR
                        </Text>
                        <Text
                            fontSize="2xl"
                            fontWeight="bold"
                            color="green.400"
                            fontFamily="mono"
                        >
                            {userAPR.toFixed(2)}%
                        </Text>
                    </VStack>

                    {/* Health Indicator */}
                    <VStack align="start" spacing={1} flex={1}>
                        <Text
                            fontSize="xs"
                            color="gray.400"
                            fontFamily="mono"
                            textTransform="uppercase"
                        >
                            Health
                        </Text>
                        <VStack align="start" spacing={1} w="100%">
                            <HStack spacing={2}>
                                <Text
                                    fontSize="lg"
                                    fontWeight="bold"
                                    color={healthColor}
                                    fontFamily="mono"
                                >
                                    {healthLabel}
                                </Text>
                                <Text
                                    fontSize="sm"
                                    color="gray.500"
                                    fontFamily="mono"
                                >
                                    ({currentLTV.toFixed(0)}% LTV)
                                </Text>
                            </HStack>
                            <Progress
                                value={currentLTV}
                                max={100}
                                size="xs"
                                colorScheme={currentLTV < 60 ? 'green' : currentLTV < 80 ? 'yellow' : 'red'}
                                bg="gray.700"
                                borderRadius="full"
                                w="100%"
                            />
                        </VStack>
                    </VStack>
                </HStack>
            </VStack>
        </Card>
    )
}

