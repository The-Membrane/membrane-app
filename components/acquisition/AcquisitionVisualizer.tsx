import React, { useRef, useEffect, useMemo, useState } from 'react'
import { Box, VStack, Text } from '@chakra-ui/react'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { Card } from '@/components/ui/Card'
import { useAcquisition, useCurrentAcquisition } from '@/hooks/useAcquisition'
import useDebounce from '@/hooks/useDebounce'
import { AcquisitionProgressBar } from './AcquisitionProgressBar'
import { useTransmuterVolumeHistory, useTransmuterData } from '@/hooks/useTransmuterData'
import { transformVolumeHistoryToChartData } from '@/services/transmuter'
import { CumulativeChart } from '@/components/DittoSpeechBox/sections/CumulativeChart'
import useAcquisitionDeposit from './hooks/useAcquisitionDeposit'
import { AcquisitionClaimCard } from './AcquisitionClaimCard'
import { useMostProfitableSlot5 } from '@/hooks/useMostProfitableSlot5'
import { useLockdropClaimsReady } from '@/components/DittoSpeechBox/hooks/useAcquisitionNotifications'
import useWallet from '@/hooks/useWallet'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useChainRoute } from '@/hooks/useChainRoute'
import { DEBOUNCE_DELAY } from './VisualizerPhysics'
import { useVisualizerDitto } from './hooks/VisualizerDitto'
import { useVisualizerBubbles } from './hooks/VisualizerBubbles'
import { AcquisitionVisualizerCanvas } from './AcquisitionVisualizerCanvas'
import { AcquisitionVisualizerSliders } from './AcquisitionVisualizerSliders'
import { AcquisitionVisualizerStats } from './AcquisitionVisualizerStats'
import { AcquisitionVisualizerLockButton } from './AcquisitionVisualizerLockButton'

export const AcquisitionVisualizer: React.FC = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const [depositAmount, setDepositAmount] = useState(1_000_000)
    const [lockDays, setLockDays] = useState(180)
    const { allocations, totalPoints, groupedByLockDays, isLoading } = useAcquisition()
    const { data: currentLockdrop } = useCurrentAcquisition()
    const { data: volumeHistory } = useTransmuterVolumeHistory(100)
    const { claimsReady, claimableAmount } = useLockdropClaimsReady()
    const { address } = useWallet()
    const { chainName } = useChainRoute()
    const { tvl: transmuterTVL } = useTransmuterData()

    // Get balance for Ditto facts
    const usdcAsset = useAssetBySymbol('USDC', chainName)
    const cdtAsset = useAssetBySymbol('CDT', chainName)
    const usdcBalance = useBalanceByAsset(usdcAsset)
    const cdtBalance = useBalanceByAsset(cdtAsset)

    // Most profitable slot 5 asset for retention incentive intent
    const { data: mostProfitableSlot5 } = useMostProfitableSlot5()

    // Lock hook - use debounced values for amount and lock days
    const debouncedDepositForHook = useDebounce(depositAmount, 300)
    const debouncedLockDaysForHook = useDebounce(lockDays, 300)

    const lockHook = useAcquisitionDeposit({
        lockDays: debouncedLockDaysForHook,
        amount: debouncedDepositForHook.toString(),
        intentAsset: mostProfitableSlot5?.asset,
        intentSlot: mostProfitableSlot5?.slot,
        txSuccess: () => {
            console.log('Lock successful!')
        },
    })

    const handleLock = async () => {
        if (!lockHook.action?.simulate?.data) return
        await lockHook.action.tx.mutateAsync()
    }
    const volumeChartData = useMemo(() => {
        if (!volumeHistory?.records) return []
        return transformVolumeHistoryToChartData(volumeHistory.records)
    }, [volumeHistory])

    // Store previous bubble positions for stability
    const previousBubblePositions = useRef<Map<string, { x: number; y: number }>>(new Map())

    // Ditto page integration (side-effecting hook)
    useVisualizerDitto({
        allocations,
        address,
        transmuterTVL,
        cdtBalance,
        usdcBalance,
        claimsReady,
    })

    // Debug logging
    useEffect(() => {
        console.log('Visualizer data:', {
            allocationsCount: allocations.length,
            totalPoints,
            groupedByLockDaysKeys: Object.keys(groupedByLockDays),
            isLoading,
        })
    }, [allocations.length, totalPoints, groupedByLockDays, isLoading])

    // Debounce slider values
    const debouncedDeposit = useDebounce(depositAmount, DEBOUNCE_DELAY)
    const debouncedLockDays = useDebounce(lockDays, DEBOUNCE_DELAY)

    // Derived allocation data, bubble layout, and canvas draw effect
    const { calculatedData } = useVisualizerBubbles({
        allocations,
        debouncedDeposit,
        debouncedLockDays,
        previousBubblePositions,
        canvasRef,
    })

    if (isLoading) {
        return (
            <Box
                w="100%"
                h="100vh"
                display="flex"
                alignItems="center"
                justifyContent="center"
                bg={SEMANTIC_COLORS.bgPrimary}
                color={SEMANTIC_COLORS.textSecondary}
                fontFamily="mono"
            >
                <Text>Loading lockdrop data...</Text>
            </Box>
        )
    }

    return (
        <Box
            w="100%"
            minH="100vh"
            bg={SEMANTIC_COLORS.bgPrimary}
            position="relative"
            p={8}
        >
            {/* Page Title */}
            <Text
                as="h1"
                fontSize={TYPOGRAPHY.h1}
                fontWeight={TYPOGRAPHY.bold}
                color={SEMANTIC_COLORS.textPrimary}
                fontFamily={TYPOGRAPHY.fontDisplay}
                textAlign="left"
                w="100%"
                maxW="1400px"
                mx="auto"
                mb={4}
            >
                Transmuter Lockdrop
            </Text>

            {/* Volume Chart */}
            {volumeChartData.length > 0 && (
                <Box mt={8} mb={8}>
                    <Text fontSize="sm" color={SEMANTIC_COLORS.textSecondary} mb={3}>
                        All-Time Volume
                    </Text>
                    <CumulativeChart data={volumeChartData} isLoading={false} />
                </Box>
            )}
            {/* Etch-a-sketch frame */}
            <Card
                variant="default"
                position="relative"
                maxW="1400px"
                mx="auto"
                bg={SEMANTIC_COLORS.bgSecondary}
                borderRadius={0}
                borderColor={SEMANTIC_COLORS.borderSubtle}
                p={SPACING.lg}
            >
                {/* Title */}
                <VStack spacing={SPACING.lg} mb={6}>
                    <Text
                        fontSize="2xl"
                        color={SEMANTIC_COLORS.textPrimary}
                        fontFamily="heading"
                    >
                        Lockdrop
                    </Text>
                    <AcquisitionProgressBar
                        startTime={currentLockdrop?.lockdrop?.start_time}
                        depositEnd={currentLockdrop?.lockdrop?.deposit_end}
                        withdrawalEnd={currentLockdrop?.lockdrop?.withdrawal_end}
                    />
                </VStack>

                {/* Canvas Screen */}
                <AcquisitionVisualizerCanvas canvasRef={canvasRef} />

                {/* Sliders (Etch-a-sketch knobs) */}
                <AcquisitionVisualizerSliders
                    depositAmount={depositAmount}
                    setDepositAmount={setDepositAmount}
                    lockDays={lockDays}
                    setLockDays={setLockDays}
                />

                {/* Stats */}
                <AcquisitionVisualizerStats
                    calculatedData={calculatedData}
                    debouncedDeposit={debouncedDeposit}
                />

                {/* Lock Button */}
                <AcquisitionVisualizerLockButton
                    depositAmount={depositAmount}
                    lockDays={lockDays}
                    lockHook={lockHook}
                    handleLock={handleLock}
                />

                {/* Claim Card */}
                {claimsReady && claimableAmount > 0 && (
                    <VStack mt={8} spacing={2}>
                        <AcquisitionClaimCard
                            claimableAmount={claimableAmount}
                            onClaimSuccess={() => {
                                // Refresh data after claim
                            }}
                        />
                    </VStack>
                )}
            </Card>
        </Box>
    )
}
