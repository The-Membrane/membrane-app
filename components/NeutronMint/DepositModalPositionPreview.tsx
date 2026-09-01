import React from 'react'
import { GridItem, Box, VStack, HStack, Text, Progress } from '@chakra-ui/react'
import { num } from '@/helpers/num'

interface PositionMetrics {
    collateralValue: number
    debtAmount: number
    netWorth: number
    leverage: number
    health: number
    ltv: number
    liquidationLTV: number
}

interface LiquidationData {
    type: 'price' | 'threshold'
    value: number
    symbol?: string
}

interface DepositModalPositionPreviewProps {
    currentPosition: PositionMetrics
    projectedPosition: PositionMetrics
    liquidationData: LiquidationData
}

// Health bar color
const getHealthColor = (health: number) => {
    if (health >= 80) return 'green'
    if (health >= 50) return 'yellow'
    if (health >= 20) return 'orange'
    return 'red'
}

/**
 * Right column of DepositModal — net worth, health bar, and position detail deltas. Extracted
 * verbatim from DepositModal to keep the parent under the giant-component line limit.
 */
export const DepositModalPositionPreview: React.FC<DepositModalPositionPreviewProps> = ({
    currentPosition,
    projectedPosition,
    liquidationData,
}) => {
    // Deltas
    const collateralDelta = num(projectedPosition.collateralValue).minus(currentPosition.collateralValue).toNumber()
    const netWorthDelta = num(projectedPosition.netWorth).minus(currentPosition.netWorth).toNumber()
    const ltvDelta = num(projectedPosition.ltv).minus(currentPosition.ltv).toNumber()

    return (
        <GridItem>
            <Box
                bg="rgba(10, 10, 10, 0.8)"
                borderRadius="lg"
                p={4}
                border="1px solid"
                borderColor="whiteAlpha.200"
            >
                <VStack spacing={4} align="stretch">
                    {/* Net Worth */}
                    <VStack align="flex-start" spacing={1}>
                        <Text color="whiteAlpha.600" fontSize="xs">
                            Net Worth
                        </Text>
                        <HStack spacing={2}>
                            <Text color="white" fontSize="lg" fontWeight="bold">
                                ${num(currentPosition.netWorth).toFixed(2)}
                            </Text>
                            {netWorthDelta !== 0 && (
                                <>
                                    <Text color="whiteAlpha.400">&rarr;</Text>
                                    <Text
                                        color={netWorthDelta >= 0 ? 'green.400' : 'red.400'}
                                        fontSize="lg"
                                        fontWeight="bold"
                                    >
                                        ${num(projectedPosition.netWorth).toFixed(2)}
                                    </Text>
                                </>
                            )}
                        </HStack>
                    </VStack>

                    {/* Health Bar */}
                    <VStack align="flex-start" spacing={1}>
                        <Text color="whiteAlpha.600" fontSize="xs">
                            Health
                        </Text>
                        <Box w="100%">
                            <Progress
                                value={projectedPosition.health}
                                colorScheme={getHealthColor(projectedPosition.health)}
                                bg="whiteAlpha.100"
                                borderRadius="full"
                                h="8px"
                            />
                        </Box>
                    </VStack>

                    {/* Position Details */}
                    <VStack align="stretch" spacing={2}>
                        <HStack justify="space-between">
                            <Text color="whiteAlpha.600" fontSize="xs">
                                Collateral Value
                            </Text>
                            <HStack spacing={1}>
                                <Text color="white" fontSize="sm" fontWeight="medium">
                                    ${num(currentPosition.collateralValue).toFixed(2)}
                                </Text>
                                {collateralDelta !== 0 && (
                                    <>
                                        <Text color="whiteAlpha.400">&rarr;</Text>
                                        <Text color="green.400" fontSize="sm" fontWeight="medium">
                                            ${num(projectedPosition.collateralValue).toFixed(2)}
                                        </Text>
                                    </>
                                )}
                            </HStack>
                        </HStack>
                        <HStack justify="space-between">
                            <Text color="whiteAlpha.600" fontSize="xs">
                                Total Debt
                            </Text>
                            <Text color="white" fontSize="sm" fontWeight="medium">
                                ${num(currentPosition.debtAmount).toFixed(2)}
                            </Text>
                        </HStack>
                        <HStack justify="space-between">
                            <Text color="whiteAlpha.600" fontSize="xs">
                                LTV
                            </Text>
                            <HStack spacing={1}>
                                <Text color="white" fontSize="sm" fontWeight="medium">
                                    {currentPosition.ltv.toFixed(1)}%
                                </Text>
                                {ltvDelta !== 0 && (
                                    <>
                                        <Text color="whiteAlpha.400">&rarr;</Text>
                                        <Text color="green.400" fontSize="sm" fontWeight="medium">
                                            {projectedPosition.ltv.toFixed(1)}%
                                        </Text>
                                    </>
                                )}
                            </HStack>
                        </HStack>
                        <HStack justify="space-between">
                            <Text color="whiteAlpha.600" fontSize="xs">
                                {liquidationData.type === 'price' ? 'Liquidation Price' : 'Liquidation Threshold'}
                            </Text>
                            <Text color="white" fontSize="sm" fontWeight="medium">
                                {liquidationData.type === 'price'
                                    ? `$${num(liquidationData.value).toFixed(2)}${liquidationData.symbol ? ` (${liquidationData.symbol})` : ''}`
                                    : `$${num(liquidationData.value).toFixed(2)}`
                                }
                            </Text>
                        </HStack>
                    </VStack>
                </VStack>
            </Box>
        </GridItem>
    )
}
