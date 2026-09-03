import React, { useEffect, useRef, useState, useMemo } from 'react'
import {
    Box,
    VStack,
    HStack,
    Text,
    SimpleGrid,
    Container,
    useBreakpointValue,
} from '@chakra-ui/react'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { BoostBreakdown } from '@/components/Manic/BoostBreakdown'
import { RevenuePerSecond } from './RevenuePerSecond'
import { RevenueChart } from './RevenueChart'
import { BoostLevelBar } from './BoostLevelBar'
import { ContributionMeter } from './ContributionMeter'
import { YourRecord } from './YourRecord'
import { AcquisitionInfo } from './AcquisitionInfo'
import { ActionReward, useActionReward } from './ActionReward'
import { AirdropEvent, useAirdropEvent } from './AirdropEvent'
import usePortState from '@/persisted-state/usePortState'
import { usePortMetrics } from './hooks/usePortMetrics'
import { PointsProgressCard } from '@/components/Points/PointsProgressCard'
import { useDittoPage } from '@/components/DittoSpeechBox/hooks/useDittoPage'
import { portfolioContract } from '@/contracts/portfolioContract'
import useWallet from '@/hooks/useWallet'
import { useRouter } from 'next/router'
import { useChainRoute } from '@/hooks/useChainRoute'

export const PortPage: React.FC = () => {
    const { data: metrics } = usePortMetrics()
    const { portState, setPortState } = usePortState()
    const { currentReward, triggerReward, closeReward } = useActionReward()
    const { airdropAmount, checkAirdrop, closeAirdrop } = useAirdropEvent()
    const prevLifetimeRevenueRef = useRef(portState.lifetimeRevenue)
    const [claimEnabled, setClaimEnabled] = useState(false)
    const { address } = useWallet()
    const router = useRouter()
    const { chainName } = useChainRoute()

    // Detect if components are side-by-side (md breakpoint = 2 columns)
    const isSideBySide = useBreakpointValue({ base: false, md: true }) ?? false

    // Initialize session on mount
    useEffect(() => {
        if (!portState.sessionStartTime) {
            setPortState({ sessionStartTime: Date.now() })
        }
    }, [portState.sessionStartTime, setPortState]) // guard makes this set-once; setPortState is a stable zustand action

    // Update revenue tracking
    useEffect(() => {
        if (!metrics) return

        // Update lifetime revenue only if it increased
        if (metrics.totalRevenue > prevLifetimeRevenueRef.current) {
            prevLifetimeRevenueRef.current = metrics.totalRevenue
            setPortState({ lifetimeRevenue: metrics.totalRevenue })
        }
    }, [metrics, setPortState])

    // Check for airdrop on page load
    useEffect(() => {
        const timer = setTimeout(() => {
            checkAirdrop(false)
        }, 2000) // Check after 2 seconds

        return () => clearTimeout(timer)
        // Intentionally mount-only: checkAirdrop is a non-memoized fn from useAirdropEvent,
        // so adding it would re-arm this 2s timer every render and it would never fire.
    }, [])

    // =====================
    // DITTO INTEGRATION
    // =====================
    
    // Calculate days since last visit
    const daysSinceLastVisit = useMemo(() => {
        if (!portState.lastVisitTime) return 0
        const now = Date.now()
        const diff = now - portState.lastVisitTime
        return Math.floor(diff / (1000 * 60 * 60 * 24))
    }, [portState.lastVisitTime])
    
    // Memoized so the facts object identity is stable across renders; it feeds Hook
    // deps inside useDittoPage (prevFacts effect + shortcut filtering). Recomputes
    // only when an input value changes, preserving the same values as before.
    const dittoFacts = useMemo(() => ({
            // Aggregate facts
            totalValue: metrics?.totalRevenue || 0,
            totalEarnings: portState.lifetimeRevenue || 0,
            dailyEarnings: metrics?.dailyRevenue || 0,
            
            // Manic position (would need actual data from Manic hooks)
            hasManicPosition: false, // Would check actual Manic position
            manicTVL: 0,
            manicAPR: 0,
            manicRiskScore: 0,
            
            // Disco position (would need actual data from Disco hooks)
            hasDiscoPosition: false,
            discoMBRN: 0,
            discoRewards: 0,
            discoBoost: 1,
            
            // Transmuter position (would need actual data)
            hasAcquisition: false,
            lockdropValue: 0,
            lockdropMBRN: 0,
            
            // Aggregate rewards
            totalPendingRewards: 0, // Would aggregate from all sources
            hasClaimableRewards: claimEnabled,
            
            // Health indicators
            worstRiskScore: 0, // Would calculate max risk across positions
            needsAttention: false,
            
            // Time-based
            lastVisit: portState.lastVisitTime || 0,
            daysSinceLastVisit,
            
            // Connection
            isConnected: !!address,
            hasAnyPosition: false, // Would check all positions
    }), [metrics?.totalRevenue, portState.lifetimeRevenue, metrics?.dailyRevenue, claimEnabled, portState.lastVisitTime, daysSinceLastVisit, address])

    // Ditto page integration
    const ditto = useDittoPage({
        contract: portfolioContract,
        facts: dittoFacts,
        onShortcut: (shortcutId: string, action: string) => {
            switch (action) {
                case 'claimAllRewards':
                    // Would trigger claim for all products
                    break
                case 'navigateToManic':
                    router.push(`/${chainName}/manic`)
                    break
                case 'navigateToDisco':
                    router.push(`/${chainName}/disco`)
                    break
            }
        },
    })
    
    // Update last visit time
    useEffect(() => {
        setPortState({ lastVisitTime: Date.now() })
    }, [setPortState])

    return (
        <Container maxW="container.xl" py={SPACING.xl}>
            <VStack spacing={SPACING.xl} align="stretch">
                {/* Header */}
                <HStack justify="space-between" align="center">
                    <Box>
                        <Text
                            as="h1"
                            fontSize={TYPOGRAPHY.h1}
                            fontWeight={TYPOGRAPHY.bold}
                            color={SEMANTIC_COLORS.textPrimary}
                            fontFamily={TYPOGRAPHY.fontDisplay}
                            mb={SPACING.sm}
                        >
                            Portfolio
                        </Text>
                        <Text
                            fontSize="sm"
                            color={SEMANTIC_COLORS.textSecondary}
                            fontFamily={TYPOGRAPHY.fontMono}
                        >
                            Real-time revenue tracking and boost progression
                        </Text>
                    </Box>
                    <BoostBreakdown />
                </HStack>

                {/* Retrospective leads (Badass rule 2): what happened to YOUR positions,
                    before any forward-looking metric. Demo fixtures under DemoBanner
                    until the wallet connects; real events once the §2 pipeline lands. */}
                <YourRecord />

                {/* Points Progress Card - Under the title, full width */}
                <Box w="66%" mb={SPACING.xl} alignSelf="center">
                    <Text
                        color={SEMANTIC_COLORS.textPrimary}
                        fontFamily={TYPOGRAPHY.fontMono}
                        mt={SPACING.sm}
                        mb={SPACING.base}
                        fontWeight={TYPOGRAPHY.bold}
                        justifySelf="center"
                    >
                        Keep earning points towards HIGHER yield
                    </Text>
                    <PointsProgressCard />
                </Box>

                {/* Main Metrics Grid */}
                <SimpleGrid columns={{ base: 1, md: 2 }} spacing={SPACING.lg}>
                    <RevenuePerSecond alwaysShowBreakdown={isSideBySide} />
                    <BoostLevelBar />
                </SimpleGrid>

                {/* Revenue Chart */}
                <RevenueChart />

                {/* Acquisition Info */}
                <AcquisitionInfo />

                {/* Contribution Meter */}
                {/* <ContributionMeter /> */}

                {/* Action Reward Popup */}
                {currentReward && (
                    <ActionReward reward={currentReward} onClose={closeReward} />
                )}

                {/* Airdrop Event */}
                {airdropAmount !== null && (
                    <AirdropEvent amount={airdropAmount} onClose={closeAirdrop} />
                )}
            </VStack>
        </Container>
    )
}

// Export hook for triggering rewards from other components
export { useActionReward } from './ActionReward'
export { useAirdropEvent } from './AirdropEvent'
