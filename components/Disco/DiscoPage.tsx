import React from 'react'
import { Box, Stack } from '@chakra-ui/react'
import { DiscoBallMeteor } from './DiscoBallMeteor'
import { ForcefieldBarriers } from './ForcefieldBarriers'
import { PortfolioSection } from './PortfolioSection'
import { MetricsSection } from './MetricsSection'
import { useDiscoAssets, useAllUserDiscoDeposits } from '@/hooks/useDiscoData'
import useWallet from '@/hooks/useWallet'
import { useQueries } from '@tanstack/react-query'
import { getLTVQueue } from '@/services/disco'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import { mockUserDeposits } from './mockData'

export const DiscoPage = React.memo(() => {
    const { address } = useWallet()
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)
    const { data: assets } = useDiscoAssets()
    const depositQueries = useAllUserDiscoDeposits(address)

    // Get all user deposits - use mock data if no real data
    const realDeposits = depositQueries
        .map(q => q.data?.deposits || [])
        .flat()

    // Use mock data for development if no real deposits
    const userDeposits = realDeposits.length > 0 ? realDeposits : mockUserDeposits

    // Query LTV queues for all assets (for forcefield barriers)
    const ltvQueueQueries = useQueries({
        queries: (assets?.assets || []).map((asset: string) => ({
            queryKey: ['disco', 'ltv_queue', asset, appState.rpcUrl],
            queryFn: () => getLTVQueue(client || null, asset),
            enabled: !!client && !!asset,
            staleTime: 1000 * 60 * 5,
        }))
    })

    const ltvQueues = ltvQueueQueries.map((q, index) => ({
        asset: assets?.assets?.[index] || '',
        queue: q.data?.queue,
    }))

    return (
        <Box
            position="relative"
            w="100%"
            minH="100vh"
            bg="transparent"
        >
            {/* Disco Ball/Meteor - Top Left */}
            <DiscoBallMeteor />

            {/* Main Content */}
            <Stack
                direction="column"
                spacing={8}
                pt="120px"
                pb={8}
            >
                {/* Forcefield Barriers */}
                <ForcefieldBarriers
                    ltvQueues={ltvQueues}
                    userDeposits={userDeposits}
                />

                {/* Portfolio Section */}
                <PortfolioSection />

                {/* Metrics Section */}
                <MetricsSection />
            </Stack>
        </Box>
    )
})

DiscoPage.displayName = 'DiscoPage'

