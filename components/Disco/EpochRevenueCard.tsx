import React, { useMemo } from 'react'
import { Box, VStack, HStack, Text, Tooltip } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import { getCurrentEpochRevenue, getEpochCountdown } from '@/services/revenueDistributor'
import { shiftDigits } from '@/helpers/math'
import contracts from '@/config/contracts.json'
import { mockEpochRevenue, mockEpochCountdown } from './mockData'

// Color constants
const PRIMARY_PURPLE = 'rgb(166, 146, 255)'

interface EpochRevenueCardProps {
    selectedLTV?: {
        tvl: number
    } | null
}

export const EpochRevenueCard: React.FC<EpochRevenueCardProps> = ({ selectedLTV }) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)
    const discoContract = (contracts as any).ltv_disco

    // Query disco config to get revenue_distributor address
    const { data: discoConfig } = useQuery({
        queryKey: ['disco_config', discoContract, appState.rpcUrl],
        queryFn: async () => {
            if (!client || !discoContract || discoContract === '') return null
            try {
                const config = await client.queryContractSmart(discoContract, { config: {} })
                return config
            } catch (error) {
                console.error('Error fetching disco config:', error)
                return null
            }
        },
        enabled: !!client && !!discoContract && discoContract !== '',
        staleTime: 1000 * 60 * 5, // 5 minutes
    })

    const revenueDistributorAddr = discoConfig?.revenue_distributor || (contracts as any).revenue_distributor

    // Query current epoch revenue (without auto-refresh)
    const { data: epochRevenue, isLoading } = useQuery({
        queryKey: ['revenue_distributor', 'current_epoch_revenue', revenueDistributorAddr, appState.rpcUrl],
        queryFn: () => getCurrentEpochRevenue(client || null, revenueDistributorAddr || ''),
        enabled: !!client && !!revenueDistributorAddr && revenueDistributorAddr !== '',
        staleTime: 1000 * 60 * 5, // 5 minutes
    })

    // Query epoch countdown for APR calculation
    const { data: epochCountdown } = useQuery({
        queryKey: ['revenue_distributor', 'epoch_countdown', revenueDistributorAddr, appState.rpcUrl],
        queryFn: () => getEpochCountdown(client || null, revenueDistributorAddr || ''),
        enabled: !!client && !!revenueDistributorAddr && revenueDistributorAddr !== '',
        staleTime: 1000 * 60 * 5, // 5 minutes
    })

    // Use mock data if real data is not available
    const useMockData = !epochRevenue || !epochRevenue.revenue || !Array.isArray(epochRevenue.revenue) || epochRevenue.revenue.length === 0
    const epochRevenueToUse = useMockData ? mockEpochRevenue : epochRevenue

    // Calculate total revenue (fees)
    const totalRevenue = useMemo(() => {
        if (!epochRevenueToUse || !epochRevenueToUse.revenue || !Array.isArray(epochRevenueToUse.revenue)) {
            return 0
        }

        let total = 0
        epochRevenueToUse.revenue.forEach(([denom, amount]: [string, string | { toString(): string }]) => {
            const amt = typeof amount === 'string' ? amount : amount.toString()
            const amountInCDT = parseFloat(shiftDigits(amt, -6).toString())
            total += amountInCDT
        })

        return total
    }, [epochRevenueToUse])

    // Calculate TVL from selectedLTV (convert from base units to MBRN)
    const tvlInMBRN = useMemo(() => {
        if (selectedLTV?.tvl === undefined || selectedLTV?.tvl === null) return null
        return parseFloat(shiftDigits(selectedLTV.tvl.toString(), -6).toString())
    }, [selectedLTV])

    // Calculate estimated APR from epoch revenue and TVL
    const estimatedAPR = useMemo(() => {
        if (!totalRevenue || tvlInMBRN === null || tvlInMBRN === 0) return null

        // Use mock epoch countdown if real data is not available
        const epochData = epochCountdown || mockEpochCountdown

        // Get epoch duration in days
        const epochDuration = epochData.epoch_end - epochData.epoch_start
        const epochDays = Math.max(1, epochDuration / 86400) // Convert seconds to days

        // APR = (revenue / tvl) * (365 / epochDays) * 100
        const apr = (totalRevenue / tvlInMBRN) * (365 / epochDays) * 100
        return apr
    }, [totalRevenue, tvlInMBRN, epochCountdown])

    return (
        <Box
            w="100%"
            bg="rgba(10, 10, 10, 0.8)"
            p={4}
            borderRadius="md"
            border="2px solid"
            borderColor={PRIMARY_PURPLE}
            boxShadow={`0 0 20px ${PRIMARY_PURPLE}40`}
        >
            <VStack spacing={3} align="stretch">
                {/* Header */}
                <VStack spacing={1} align="flex-start">
                    <Text
                        fontSize="sm"
                        fontWeight="bold"
                        color={PRIMARY_PURPLE}
                        fontFamily="mono"
                        letterSpacing="1px"
                        textTransform="uppercase"
                    >
                        Epoch Metrics
                    </Text>
                </VStack>

                {/* Fees */}
                <VStack spacing={0} align="flex-start">
                    <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                        Fees
                    </Text>
                    <Text
                        fontSize="lg"
                        fontWeight="bold"
                        color="green.400"
                        fontFamily="mono"
                        textShadow="0 0 10px rgba(72, 187, 120, 0.6)"
                    >
                        {isLoading && !useMockData ? (
                            'Loading...'
                        ) : (
                            `${totalRevenue.toLocaleString(undefined, { maximumFractionDigits: 2 })} CDT`
                        )}
                    </Text>
                </VStack>

                {/* TVL */}
                <VStack spacing={0} align="flex-start">
                    <Text fontSize="xs" color="whiteAlpha.600" fontFamily="mono" letterSpacing="0.5px">
                        TVL
                    </Text>
                    <Text
                        fontSize="lg"
                        fontWeight="bold"
                        color={tvlInMBRN !== null ? "cyan.400" : "whiteAlpha.500"}
                        fontFamily="mono"
                        textShadow={tvlInMBRN !== null && tvlInMBRN > 0 ? "0 0 10px rgba(56, 178, 172, 0.6)" : undefined}
                    >
                        {tvlInMBRN !== null ? (
                            `${tvlInMBRN.toLocaleString(undefined, { maximumFractionDigits: 2 })} MBRN`
                        ) : (
                            'Select LTV'
                        )}
                    </Text>
                </VStack>

                {/* Estimated APR with Tooltip */}
                <VStack spacing={0} align="flex-start">
                    <Tooltip
                        label="Revenue shares are boosted by lock time so APR is a faulty stat."
                        placement="top"
                        hasArrow
                        bg="rgba(10, 10, 10, 0.95)"
                        color="whiteAlpha.800"
                        fontFamily="mono"
                        fontSize="xs"
                        p={2}
                        borderRadius="md"
                        border="1px solid"
                        borderColor={PRIMARY_PURPLE}
                    >
                        <Text
                            fontSize="xs"
                            color="whiteAlpha.600"
                            fontFamily="mono"
                            letterSpacing="0.5px"
                            cursor="help"
                            textDecoration="underline"
                            textDecorationStyle="dotted"
                        >
                            Estimated APR
                        </Text>
                    </Tooltip>
                    <Text
                        fontSize="lg"
                        fontWeight="bold"
                        color={estimatedAPR !== null ? "cyan.400" : "whiteAlpha.500"}
                        fontFamily="mono"
                        textShadow={estimatedAPR !== null ? "0 0 10px rgba(56, 178, 172, 0.6)" : undefined}
                    >
                        {estimatedAPR !== null ? (
                            `${estimatedAPR.toFixed(2)}%`
                        ) : (
                            'N/A'
                        )}
                    </Text>
                </VStack>

                {/* Empty State */}
                {!isLoading && !useMockData && totalRevenue === 0 && (
                    <Box
                        p={2}
                        textAlign="center"
                        color="whiteAlpha.500"
                        fontFamily="mono"
                        fontSize="xs"
                    >
                        No revenue this epoch
                    </Box>
                )}
            </VStack>
        </Box>
    )
}
