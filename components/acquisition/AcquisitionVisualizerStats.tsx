import React from 'react'
import { HStack, VStack, Text } from '@chakra-ui/react'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { VisualizerCalculatedData } from './VisualizerPhysics'

interface AcquisitionVisualizerStatsProps {
    calculatedData: VisualizerCalculatedData
    debouncedDeposit: number
}

export const AcquisitionVisualizerStats: React.FC<AcquisitionVisualizerStatsProps> = ({
    calculatedData,
    debouncedDeposit,
}) => {
    return (
        <HStack
            spacing={6}
            justify="center"
            mt={6}
            flexWrap="wrap"
            fontFamily="mono"
        >
            <VStack spacing={1}>
                <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                    TOTAL POINTS
                </Text>
                <Text fontSize="lg" color={SEMANTIC_COLORS.primary} fontWeight="bold">
                    {calculatedData.totalPoints.toLocaleString(undefined, {
                        maximumFractionDigits: 2,
                    })}
                </Text>
            </VStack>
            <VStack spacing={1}>
                <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                    YOUR SHARE
                </Text>
                <Text fontSize="lg" color={SEMANTIC_COLORS.info} fontWeight="bold">
                    {debouncedDeposit > 0
                        ? ((
                            calculatedData.allocations.find(a => a.user === 'hypothetical')
                                ?.allocation || 0
                        ) * 100).toFixed(2)
                        : 0}
                    %
                </Text>
            </VStack>
            <VStack spacing={1}>
                <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary}>
                    YOUR ALLOCATION
                </Text>
                <Text fontSize="lg" color={SEMANTIC_COLORS.primary} fontWeight="bold">
                    {debouncedDeposit > 0
                        ? (
                            (calculatedData.allocations.find(a => a.user === 'hypothetical')
                                ?.allocation || 0) * 10_000_000
                        ).toLocaleString(undefined, {
                            maximumFractionDigits: 0,
                        })
                        : '0'}
                    {' '}MBRN
                </Text>
            </VStack>
        </HStack>
    )
}
