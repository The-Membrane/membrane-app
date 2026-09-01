import React, { useMemo } from 'react'
import { VStack, Text, Box, HStack, Divider } from '@chakra-ui/react'
import { SectionComponentProps } from '../types'
import { useTransmuterData, useTransmuterVolumeHistory } from '@/hooks/useTransmuterData'
import { transformVolumeHistoryToChartData } from '@/services/transmuter'
import { CumulativeChart } from './CumulativeChart'

import { SEMANTIC_COLORS } from '@/config/semanticColors'

export const TransmuterSection: React.FC<SectionComponentProps & { tabIndex?: number; hideCharts?: boolean }> = ({ onBack, tabIndex = 0, hideCharts = false }) => {
    const { tvl, apr, isLoading } = useTransmuterData()
    const { data: volumeHistory } = useTransmuterVolumeHistory(100)

    // Transform volume history to chart data
    const volumeChartData = useMemo(() => {
        if (!volumeHistory?.records) {
            console.log('[TransmuterSection] No volume history records:', volumeHistory)
            return []
        }
        console.log('[TransmuterSection] Volume history records:', volumeHistory.records.length, volumeHistory.records[0])
        const transformed = transformVolumeHistoryToChartData(volumeHistory.records)
        console.log('[TransmuterSection] Transformed chart data:', transformed.length, transformed[0])
        return transformed
    }, [volumeHistory])



    // Data Tab (index 0)
    if (tabIndex === 0) {
        return (
            <VStack spacing={3} align="stretch" w="100%">
                <Box>
                    <HStack spacing={4} align="flex-start" wrap="wrap" justifyContent={"center"}>
                        <VStack>
                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} mb={1}>
                                TVL
                            </Text>
                            <Text fontSize="sm" fontWeight="bold" color={SEMANTIC_COLORS.textPrimary} mb={3}>
                                {tvl > 0 ? `${tvl.toFixed(2)} USDC` : '—'}
                            </Text>
                        </VStack>

                        <VStack>
                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} mb={1}>
                                30D APR
                            </Text>
                            <Text fontSize="sm" fontWeight="bold" color={SEMANTIC_COLORS.info} mb={3}>
                                {apr !== null ? `${apr.toFixed(2)}%` : '—'}
                            </Text>
                        </VStack>
                    </HStack>
                </Box>

                {!hideCharts && volumeChartData.length > 0 && (
                    <>
                        <Divider mb={4} mt={4} />
                        <Box>
                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} mb={2}>
                                All-Time Volume
                            </Text>
                            <CumulativeChart data={volumeChartData} isLoading={false} />
                        </Box>
                    </>
                )}
            </VStack>
        )
    }

    // Metrics Tab (index 1)
    if (tabIndex === 1) {
        return (
            <Box>
                <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} mb={2}>
                    No metrics available
                </Text>
            </Box>
        )
    }

    // Actions Tab (index 2)
    return (
        <Box>
            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} mb={2}>
                Navigate to Transmuter page for actions
            </Text>
        </Box>
    )
}

