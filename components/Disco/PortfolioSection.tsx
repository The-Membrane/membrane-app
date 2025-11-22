import React, { useMemo } from 'react'
import { Box, VStack, Text, Stack } from '@chakra-ui/react'
import { DepositCard } from './DepositCard'
import { sortDepositsByLTVPair } from './utils'
import { useDiscoUserMetrics, useDiscoAssets, useAllUserDiscoDeposits } from '@/hooks/useDiscoData'
import useWallet from '@/hooks/useWallet'
import { mockUserDeposits } from './mockData'

export const PortfolioSection = React.memo(() => {
    const { address } = useWallet()
    const { data: assets } = useDiscoAssets()
    const depositQueries = useAllUserDiscoDeposits(address)
    const { isLoading } = useDiscoUserMetrics(address)

    // Use mock data for development
    const useMockData = !address || depositQueries.every(q => !q.data || q.data.deposits?.length === 0)

    // Group deposits by asset - use mock data if no real data available
    const groupedDeposits = useMemo(() => {
        const depositsToUse = useMockData ? mockUserDeposits : (
            depositQueries
                .map((query, index) => {
                    const asset = assets?.assets?.[index] || 'MBRN'
                    const queryDeposits = query.data?.deposits || []
                    return queryDeposits.map((deposit: any) => ({
                        ...deposit,
                        asset,
                        ltv: deposit.ltv || '0',
                        max_ltv: deposit.max_ltv || deposit.ltv || '0',
                    }))
                })
                .flat()
        )

        const grouped: Record<string, any[]> = {}

        depositsToUse.forEach((deposit: any) => {
            const asset = deposit.asset || 'MBRN'
            if (!grouped[asset]) {
                grouped[asset] = []
            }
            grouped[asset].push(deposit)
        })

        // Sort each group by LTV pair (lowest at bottom, highest at top)
        Object.keys(grouped).forEach(asset => {
            grouped[asset] = sortDepositsByLTVPair(grouped[asset])
        })

        return grouped
    }, [assets, depositQueries, useMockData])

    if (isLoading) {
        return (
            <Box p={8}>
                <Text>Loading deposits...</Text>
            </Box>
        )
    }

    const allDeposits = Object.values(groupedDeposits).flat()

    if (allDeposits.length === 0 && !useMockData) {
        return (
            <Box p={8}>
                <Text>No deposits found</Text>
            </Box>
        )
    }

    return (
        <Box w="100%" maxW="1200px" mx="auto" p={8}>
            <Text
                variant="title"
                fontSize="2xl"
                fontWeight="bold"
                mb={6}
            >
                Your Disco Portfolio
            </Text>

            <VStack spacing={0} align="stretch">
                {Object.entries(groupedDeposits).map(([asset, assetDeposits]) => (
                    <Box key={asset} mb={6}>
                        <Text fontSize="md" color="whiteAlpha.700" mb={3}>
                            {asset}
                        </Text>
                        <Stack spacing={0}>
                            {/* Render in reverse order so lowest is at bottom */}
                            {[...assetDeposits].reverse().map((deposit: any, index: number) => (
                                <DepositCard
                                    key={`${deposit.deposit_id || index}-${asset}`}
                                    deposit={deposit}
                                    asset={asset}
                                />
                            ))}
                        </Stack>
                    </Box>
                ))}
            </VStack>
        </Box>
    )
})

PortfolioSection.displayName = 'PortfolioSection'

