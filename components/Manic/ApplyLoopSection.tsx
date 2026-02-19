import React, { useMemo } from 'react'
import {
    Box,
    Card,
    VStack,
    HStack,
    Text,
    Button,
    Tooltip,
} from '@chakra-ui/react'
import { WarningIcon } from '@chakra-ui/icons'

interface ApplyLoopSectionProps {
    hasPosition: boolean
    targetLoopLevel: number
    currentLoopLevel: number
    baseAPR: number
    collateralAmount: number
    transmuterBalance: number
    onApplyLoop: () => void
    isLoading?: boolean
}

export const ApplyLoopSection: React.FC<ApplyLoopSectionProps> = ({
    hasPosition,
    targetLoopLevel,
    currentLoopLevel,
    baseAPR,
    collateralAmount,
    transmuterBalance,
    onApplyLoop,
    isLoading = false,
}) => {
    // Calculate new net APR at target loop level
    const targetAPR = useMemo(() => {
        return baseAPR * targetLoopLevel
    }, [baseAPR, targetLoopLevel])

    // Calculate required capacity
    // Required = collateral × target multiplier (approximately)
    const requiredCapacity = useMemo(() => {
        if (!hasPosition || collateralAmount <= 0) return 0
        return collateralAmount * targetLoopLevel
    }, [hasPosition, collateralAmount, targetLoopLevel])

    // Check if we can apply the loop
    const canApply = useMemo(() => {
        if (!hasPosition) return false
        if (targetLoopLevel <= currentLoopLevel) return false
        if (requiredCapacity > transmuterBalance) return false
        return true
    }, [hasPosition, targetLoopLevel, currentLoopLevel, requiredCapacity, transmuterBalance])

    // Determine disabled reason
    const disabledReason = useMemo(() => {
        if (!hasPosition) return 'Deposit required to enable looping'
        if (targetLoopLevel <= currentLoopLevel) return 'Target must be higher than current loop level'
        if (requiredCapacity > transmuterBalance) return `Insufficient capacity (need ${requiredCapacity.toLocaleString()} USDC, available ${transmuterBalance.toLocaleString()} USDC)`
        return null
    }, [hasPosition, targetLoopLevel, currentLoopLevel, requiredCapacity, transmuterBalance])

    // Don't render if no position
    if (!hasPosition) {
        return null
    }

    // Determine button text
    const buttonText = useMemo(() => {
        if (targetLoopLevel <= currentLoopLevel) {
            return `Current: ${currentLoopLevel.toFixed(1)}×`
        }
        return `Increase Loop to ${targetLoopLevel.toFixed(1)}×`
    }, [targetLoopLevel, currentLoopLevel])

    return (
        <Card
            bg="gray.800"
            borderColor={canApply ? "purple.500" : "gray.600"}
            borderWidth="2px"
            p={6}
            w="100%"
            boxShadow={canApply ? "0 0 20px rgba(159, 122, 234, 0.15)" : "none"}
            transition="all 0.3s"
        >
            <VStack spacing={4} align="stretch">
                {/* Header */}
                <Text
                    fontSize="sm"
                    color="gray.400"
                    fontFamily="mono"
                    textTransform="uppercase"
                >
                    Apply Loop Configuration
                </Text>

                {/* Summary Panel */}
                <HStack spacing={8} w="100%" justify="space-between" flexWrap="wrap">
                    {/* Target Loops */}
                    <VStack align="start" spacing={0}>
                        <Text fontSize="xs" color="gray.500" fontFamily="mono">
                            Target Loop
                        </Text>
                        <HStack spacing={2} align="baseline">
                            <Text fontSize="xl" fontWeight="bold" color="cyan.400" fontFamily="mono">
                                {targetLoopLevel.toFixed(1)}×
                            </Text>
                            <Text fontSize="sm" color="gray.500" fontFamily="mono">
                                (from {currentLoopLevel.toFixed(1)}×)
                            </Text>
                        </HStack>
                    </VStack>

                    {/* New Net APR */}
                    <VStack align="start" spacing={0}>
                        <Text fontSize="xs" color="gray.500" fontFamily="mono">
                            Projected APR
                        </Text>
                        <Text fontSize="xl" fontWeight="bold" color="green.400" fontFamily="mono">
                            {targetAPR.toFixed(2)}%
                        </Text>
                    </VStack>

                    {/* Required Capacity */}
                    <VStack align="start" spacing={0}>
                        <Text fontSize="xs" color="gray.500" fontFamily="mono">
                            Required Capacity
                        </Text>
                        <Text
                            fontSize="xl"
                            fontWeight="bold"
                            color={requiredCapacity <= transmuterBalance ? "white" : "red.400"}
                            fontFamily="mono"
                        >
                            {requiredCapacity.toLocaleString(undefined, { maximumFractionDigits: 0 })} USDC
                        </Text>
                    </VStack>

                    {/* CTA Button */}
                    <Box>
                        <Tooltip
                            label={disabledReason}
                            isDisabled={canApply}
                            fontSize="xs"
                            bg="gray.800"
                            color="#F5F5F5"
                            border="1px solid"
                            borderColor="red.500"
                            borderRadius="md"
                            p={3}
                            hasArrow
                        >
                            <Button
                                size="lg"
                                colorScheme={canApply ? "purple" : "gray"}
                                bg={canApply ? "purple.500" : "gray.600"}
                                color="white"
                                onClick={onApplyLoop}
                                isDisabled={!canApply}
                                isLoading={isLoading}
                                fontFamily="mono"
                                fontSize="md"
                                px={8}
                                minW="200px"
                                _hover={canApply ? {
                                    bg: 'purple.400',
                                    transform: 'scale(1.02)',
                                } : {}}
                                _disabled={{
                                    opacity: 0.6,
                                    cursor: 'not-allowed',
                                }}
                            >
                                {buttonText}
                            </Button>
                        </Tooltip>
                    </Box>
                </HStack>

                {/* Inline warning if disabled */}
                {disabledReason && !canApply && (
                    <HStack spacing={2} color="gray.500">
                        <WarningIcon boxSize={3} />
                        <Text fontSize="xs" fontFamily="mono">
                            {disabledReason}
                        </Text>
                    </HStack>
                )}
            </VStack>
        </Card>
    )
}









