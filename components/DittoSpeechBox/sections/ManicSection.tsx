import React, { useState, useEffect } from 'react'
import { VStack, Text, Box, Button, HStack, Divider } from '@chakra-ui/react'
import { AnimatePresence } from 'framer-motion'
import { useManicData, useDeploymentProfitData } from '@/hooks/useManic'
import { SectionComponentProps } from '../types'
import { useRouter } from 'next/router'
import { useChainRoute } from '@/hooks/useChainRoute'
import { ProfitChart } from './ProfitChart'
import useFulfillIntent from '@/components/Manic/hooks/useFulfillIntent'
import { useLoopAnimationState } from '@/components/Manic/hooks/useLoopAnimationState'
import { DepositCard, WithdrawCard } from '@/components/Manic/DepositModal'
import useManicDeposit from '@/components/Manic/hooks/useManicDeposit'
import useManicWithdraw from '@/components/Manic/hooks/useManicWithdraw'

import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

const handleNavigate = () => {
    // router.push(`/${chainName}/manic`)
}

export const ManicSection: React.FC<SectionComponentProps & { tabIndex?: number; hideCharts?: boolean }> = ({ onBack, tabIndex = 0, hideCharts = false }) => {
    const { funnelFillRatio, aprMetrics, hasPosition, usdcPosition, baseDeposit } = useManicData()
    const { data: profitData, isLoading: isLoadingProfit } = useDeploymentProfitData()
    const router = useRouter()
    const { chainName } = useChainRoute()
    // react-doctor(rerender-state-only-in-handlers) FP: view-state, not an instance value — drives the Loop button's isLoading/isDisabled (currently commented out, ~L283-284). Keep useState; useRef would break re-render when those are re-enabled.
    const [isLooping, setIsLooping] = useState(false)
    const [showDepositCard, setShowDepositCard] = useState(false)
    const [showWithdrawCard, setShowWithdrawCard] = useState(false)
    const { triggerAnimation, isManuallyActive, startAnimation, stopAnimation } = useLoopAnimationState()

    // State for deposit/withdraw amounts
    const [depositAmount, setDepositAmount] = useState('')
    const [withdrawAmount, setWithdrawAmount] = useState('')

    // Deposit hook
    const depositHook = useManicDeposit({
        amount: depositAmount,
        txSuccess: () => {
            setShowDepositCard(false)
            setDepositAmount('')
        },
    })

    // Withdraw hook
    const withdrawHook = useManicWithdraw({
        amount: withdrawAmount,
        txSuccess: () => {
            setShowWithdrawCard(false)
            setWithdrawAmount('')
        },
    })

    // Loop action hook
    const { action: fulfillIntent } = useFulfillIntent(
        usdcPosition?.positionId ? String(usdcPosition.positionId) : undefined,
        usdcPosition?.debtAmount ? usdcPosition.debtAmount * 0.9 : undefined // Use 90% of debt as max mint
    )

    // Watch for transaction success and stop animation
    useEffect(() => {
        if (fulfillIntent.tx.isSuccess && fulfillIntent.tx.data) {
            console.log('[ManicSection] Transaction successful, stopping animation')
            stopAnimation()
        }
    }, [fulfillIntent.tx.isSuccess, fulfillIntent.tx.data, stopAnimation])

    // Watch for transaction error and stop animation
    useEffect(() => {
        if (fulfillIntent.tx.isError && fulfillIntent.tx.error) {
            console.log('[ManicSection] Transaction error, stopping animation')
            stopAnimation()
        }
    }, [fulfillIntent.tx.isError, fulfillIntent.tx.error, stopAnimation])

    // Calculate average historical APR from chart data
    const averageHistoricalAPR = profitData && profitData.length > 0
        ? profitData
            .filter(d => d.apr !== undefined)
            .reduce((sum, d) => sum + (d.apr || 0), 0) / profitData.filter(d => d.apr !== undefined).length
        : undefined

    const handleDepositClick = () => {
        setShowDepositCard(true)
    }

    const handleDeposit = async (amount: string) => {
        console.log('[ManicSection] Depositing:', amount)
        setDepositAmount(amount)
        // Trigger transaction after state update
        setTimeout(async () => {
            if (depositHook.action?.simulate?.data) {
                await depositHook.action.tx.mutateAsync()
            }
        }, 100)
    }

    const handleWithdrawClick = () => {
        setShowWithdrawCard(true)
    }

    const handleWithdraw = async (amount: string) => {
        console.log('[ManicSection] Withdrawing:', amount)
        setWithdrawAmount(amount)
        // Trigger transaction after state update
        setTimeout(async () => {
            if (withdrawHook.action?.simulate?.data) {
                await withdrawHook.action.tx.mutateAsync()
            }
        }, 100)
    }

    const handleLoop = async () => {
        console.log('[ManicSection] Loop clicked', {
            hasPosition,
            positionId: usdcPosition?.positionId,
            simulateReady: fulfillIntent?.simulate?.data !== undefined,
            simulateData: fulfillIntent?.simulate?.data,
            isLooping,
            isManuallyActive,
        })

        // If already manually active, stop animation
        if (isManuallyActive) {
            console.log('[ManicSection] Stopping animation')
            stopAnimation()
            return
        }

        // Start animation immediately
        console.log('[ManicSection] Starting animation...')
        startAnimation()
        triggerAnimation()

        // Only execute transaction if position exists and simulation is ready
        if (hasPosition && fulfillIntent.simulate.data) {
            try {
                setIsLooping(true)
                console.log('[ManicSection] Starting loop tx')
                await fulfillIntent.tx.mutateAsync()
                console.log('[ManicSection] Loop tx success')
                // Animation will be stopped by the useEffect watching isSuccess
            } catch (err) {
                console.error('[ManicSection] Loop failed', err)
                // Animation will be stopped by the useEffect watching isError
            } finally {
                setIsLooping(false)
                console.log('[ManicSection] Loop finished, isLooping reset')
            }
        }
        // Animation will continue looping until stopped manually or transaction completes
    }

    // Calculate current boost multiplier
    const calculateBoostMultiplier = () => {
        if (!usdcPosition?.collateralAmount || !usdcPosition?.debtAmount || usdcPosition.collateralAmount === 0) {
            return 0
        }
        const baseCollateral = usdcPosition.collateralAmount - usdcPosition.debtAmount
        if (baseCollateral <= 0) {
            return 0
        }
        // Boost multiplier = collateralAmount / baseCollateral
        return usdcPosition.collateralAmount / baseCollateral
    }

    const boostMultiplier = calculateBoostMultiplier()

    // Calculate TVL as collateral minus debt
    const tvl = usdcPosition && usdcPosition.collateralAmount && usdcPosition.debtAmount
        ? usdcPosition.collateralAmount - usdcPosition.debtAmount
        : 0

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

                        {/* {hasPosition && usdcPosition && (
                            <>
                                <Box flex={1}>
                                    <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} mb={1}>
                                        Collateral
                                    </Text>
                                    <Text fontSize="sm" color={SEMANTIC_COLORS.textPrimary}>
                                        {usdcPosition.collateralAmount.toFixed(2)} USDC
                                    </Text>
                                </Box>
                                <Box flex={1}>
                                    <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} mb={1}>
                                        Debt
                                    </Text>
                                    <Text fontSize="sm" color={SEMANTIC_COLORS.textPrimary}>
                                        {usdcPosition.debtAmount.toFixed(2)} USDC
                                    </Text>
                                </Box>
                            </>
                        )} */}
                        <VStack >
                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} mb={1}>
                                Current APR
                            </Text>
                            <Text fontSize="sm" fontWeight="bold" color={SEMANTIC_COLORS.info}>
                                {aprMetrics.userAPR.toFixed(2)}%
                            </Text>
                        </VStack>
                        <VStack >
                            <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} mb={1}>
                                Avg Historical APR
                            </Text>
                            <Text fontSize="sm" fontWeight="bold" color={SEMANTIC_COLORS.success}>
                                {averageHistoricalAPR?.toFixed(2) || '—'}%
                            </Text>
                        </VStack>
                    </HStack>
                </Box>

                <AnimatePresence mode="wait">
                    {showDepositCard ? (
                        <DepositCard
                            key="deposit-card"
                            isOpen={showDepositCard}
                            onClose={() => setShowDepositCard(false)}
                            onDeposit={handleDeposit}
                            inline={true}
                        />
                    ) : showWithdrawCard ? (
                        <WithdrawCard
                            key="withdraw-card"
                            isOpen={showWithdrawCard}
                            onClose={() => setShowWithdrawCard(false)}
                            onWithdraw={handleWithdraw}
                            inline={true}
                            tvlAmount={tvl}
                        />
                    ) : (
                        <Box key="normal-view" mb={4}>
                            {!hideCharts && (
                                <Box mt={4}>
                                    <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} mb={2}>
                                        Profit Over Time
                                    </Text>
                                    <ProfitChart data={profitData || []} isLoading={isLoadingProfit} />
                                </Box>
                            )}

                            <Divider mb={7} />

                            <HStack mt={4}>
                                <Button
                                    size="sm"
                                    // colorScheme="secondary"
                                    // bg={SEMANTIC_COLORS.info}
                                    color={SEMANTIC_COLORS.textPrimary}
                                    borderRadius={0}
                                    fontFamily={TYPOGRAPHY.fontMono}
                                    transition={TRANSITIONS.colors}
                                    _hover={HOVER_EFFECTS.borderHighlight}
                                    _active={ACTIVE_EFFECTS.dim}
                                    _focus={FOCUS_STYLES.ring}
                                    _focusVisible={FOCUS_STYLES.ring}
                                    onClick={handleDepositClick}
                                >
                                    Deposit
                                </Button>
                                {true && (<>
                                    <Button
                                        size="sm"
                                        // colorScheme="secondary"
                                        // bg={SEMANTIC_COLORS.info}
                                        color={SEMANTIC_COLORS.textPrimary}
                                        borderRadius={0}
                                        fontFamily={TYPOGRAPHY.fontMono}
                                        transition={TRANSITIONS.colors}
                                        _hover={HOVER_EFFECTS.borderHighlight}
                                        _active={ACTIVE_EFFECTS.dim}
                                        _focus={FOCUS_STYLES.ring}
                                        _focusVisible={FOCUS_STYLES.ring}
                                        onClick={handleWithdrawClick}
                                    >
                                        Withdraw
                                    </Button>
                                    <Button
                                        size="sm"
                                        // colorScheme="secondary"
                                        // bg={SEMANTIC_COLORS.info}
                                        color={SEMANTIC_COLORS.textPrimary}
                                        borderRadius={0}
                                        fontFamily={TYPOGRAPHY.fontMono}
                                        transition={TRANSITIONS.colors}
                                        _hover={HOVER_EFFECTS.borderHighlight}
                                        _active={ACTIVE_EFFECTS.dim}
                                        _focus={FOCUS_STYLES.ring}
                                        _focusVisible={FOCUS_STYLES.ring}
                                        onClick={handleLoop}
                                    // isLoading={isLooping || fulfillIntent?.tx?.isPending}
                                    // isDisabled={!fulfillIntent?.simulate?.data || isLooping}
                                    >
                                        Loop
                                    </Button>
                                </>
                                )}
                            </HStack>
                        </Box>
                    )}
                </AnimatePresence>
            </VStack>
        )
    }
}

