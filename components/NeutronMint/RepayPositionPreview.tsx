import React from 'react'
import {
    VStack,
    HStack,
    Box,
    Text,
    Progress,
} from '@chakra-ui/react'
import { num } from '@/helpers/num'
import type { useRepayModal } from './hooks/useRepayModal'
import type { useRepayLiquidationData } from './hooks/useRepayLiquidationData'

type RepayPositionValues = ReturnType<typeof useRepayModal>['currentPosition']
type RepayLiquidationData = ReturnType<typeof useRepayLiquidationData>

// Health bar color
const getHealthColor = (health: number) => {
    if (health >= 80) return 'green'
    if (health >= 50) return 'yellow'
    if (health >= 20) return 'orange'
    return 'red'
}

interface RepayPositionPreviewProps {
    currentPosition: RepayPositionValues
    projectedPosition: RepayPositionValues
    repayAmount: number
    liquidationData: RepayLiquidationData
}

export const RepayPositionPreview: React.FC<RepayPositionPreviewProps> = ({
    currentPosition,
    projectedPosition,
    repayAmount,
    liquidationData,
}) => {
    // Deltas
    const debtDelta = num(projectedPosition.debtAmount).minus(currentPosition.debtAmount).toNumber()
    const netWorthDelta = num(projectedPosition.netWorth).minus(currentPosition.netWorth).toNumber()

    return (
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
                        <Text color="white" fontSize="sm" fontWeight="medium">
                            ${num(currentPosition.collateralValue).toFixed(2)}
                        </Text>
                    </HStack>
                    <HStack justify="space-between">
                        <Text color="whiteAlpha.600" fontSize="xs">
                            Total Debt
                        </Text>
                        <HStack spacing={1}>
                            <Text color="white" fontSize="sm" fontWeight="medium">
                                ${num(currentPosition.debtAmount).toFixed(2)}
                            </Text>
                            {debtDelta !== 0 && (
                                <>
                                    <Text color="whiteAlpha.400">&rarr;</Text>
                                    <Text color="green.400" fontSize="sm" fontWeight="medium">
                                        ${num(projectedPosition.debtAmount).toFixed(2)}
                                    </Text>
                                </>
                            )}
                        </HStack>
                    </HStack>
                    <HStack justify="space-between">
                        <Text color="whiteAlpha.600" fontSize="xs">
                            LTV
                        </Text>
                        <HStack spacing={1}>
                            <Text color="white" fontSize="sm" fontWeight="medium">
                                {currentPosition.ltv.toFixed(1)}%
                            </Text>
                            {repayAmount > 0 && (
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
    )
}
