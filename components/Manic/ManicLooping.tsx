import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
    Box,
    Card,
    VStack,
    HStack,
    Text,
    Grid,
    GridItem,
    Divider,
    IconButton,
    Tooltip
} from '@chakra-ui/react'
import { InfoIcon } from '@chakra-ui/icons'
import { useManicData, useMarketConditions, useDeploymentProfitData } from '@/hooks/useManic'
import { useFlywheelMetrics } from '@/hooks/useFlywheelMetrics'
import { shiftDigits } from '@/helpers/math'
import { TYPOGRAPHY } from '@/helpers/typography'
import useFulfillIntent from './hooks/useFulfillIntent'
import { useLoopAnimationState } from './hooks/useLoopAnimationState'
import { MarketConditionsChart } from './MarketConditionsChart'
import { FlowVisualizer } from './FlowVisualizer'
import { UnifiedPositionForm } from './UnifiedPositionForm'
import { ApplyLoopSection } from './ApplyLoopSection'
import { ProfitChart } from '@/components/DittoSpeechBox/sections/ProfitChart'
import { useDittoPage } from '@/components/DittoSpeechBox/hooks/useDittoPage'
import { manicContract } from '@/contracts/manicContract'
import useWallet from '@/hooks/useWallet'
import { BoostBreakdown } from '@/components/Manic/BoostBreakdown'
import { CompactBoostSimulator } from './CompactBoostSimulator'
import useManicDeposit from './hooks/useManicDeposit'
import useManicWithdraw from './hooks/useManicWithdraw'

const ManicLooping: React.FC = () => {
    const [targetBoostMultiplier, setTargetBoostMultiplier] = useState(1)
    const [depositAmount, setDepositAmount] = useState('')
    const [withdrawAmount, setWithdrawAmount] = useState('')
    const [depositMultiplier, setDepositMultiplier] = useState(1)
    const positionRef = useRef<HTMLDivElement>(null)

    const { address } = useWallet()
    const {
        transmuterBalance,
        usdcPosition,
        funnelFillRatio,
        aprMetrics,
        hasPosition
    } = useManicData()
    const { data: marketConditions, isLoading: isLoadingMarketConditions } = useMarketConditions(100)
    const { data: profitData, isLoading: isLoadingProfit } = useDeploymentProfitData()
    const { manicTVL } = useFlywheelMetrics()
    const { isManuallyActive, startAnimation, stopAnimation } = useLoopAnimationState()

    // Calculate global metrics
    const globalManicTVL = useMemo(() => {
        if (!manicTVL) return 0
        return shiftDigits(manicTVL, -6).toNumber()
    }, [manicTVL])

    const transmuterUSDCBalance = useMemo(() => {
        if (!transmuterBalance) return 0
        return shiftDigits(transmuterBalance, -6).toNumber()
    }, [transmuterBalance])

    // Get position amounts
    const collateralAmount = useMemo(() => {
        return usdcPosition?.collateralAmount || 0
    }, [usdcPosition])

    const debtAmount = useMemo(() => {
        return usdcPosition?.debtAmount || 0
    }, [usdcPosition])

    // Calculate current loop level
    const currentLoopLevel = useMemo(() => {
        if (!hasPosition || collateralAmount <= 0) return 1
        const equity = collateralAmount - debtAmount
        if (equity <= 0) return 10
        return Math.min(collateralAmount / equity, 10)
    }, [hasPosition, collateralAmount, debtAmount])

    // Calculate position equity (equity = collateral - debt)
    const positionEquity = useMemo(() => {
        if (!hasPosition) return 0
        return Math.max(0, collateralAmount - debtAmount)
    }, [hasPosition, collateralAmount, debtAmount])

    // Calculate capacity required for target loop
    const capacityRequired = useMemo(() => {
        if (!hasPosition || targetBoostMultiplier <= currentLoopLevel) return 0
        const additionalDebt = positionEquity * (targetBoostMultiplier - currentLoopLevel)
        return additionalDebt
    }, [hasPosition, positionEquity, targetBoostMultiplier, currentLoopLevel])

    // Check if loop is disabled
    const loopDisabled = useMemo(() => {
        if (!hasPosition) return true
        if (transmuterUSDCBalance < capacityRequired) return true
        return false
    }, [hasPosition, transmuterUSDCBalance, capacityRequired])

    // Calculate a simple risk score (based on loop level)
    const riskScore = useMemo(() => {
        // Higher loop = higher risk (linear scaling from 0-100)
        return Math.min(100, (currentLoopLevel / 10) * 100)
    }, [currentLoopLevel])

    // Setup fulfill intent hook
    const { action: fulfillIntent } = useFulfillIntent(
        usdcPosition?.positionId ? String(usdcPosition.positionId) : undefined,
        usdcPosition?.debtAmount ? usdcPosition.debtAmount * 0.9 : undefined
    )

    // Watch for transaction success and stop animation
    useEffect(() => {
        if (fulfillIntent.tx.isSuccess && fulfillIntent.tx.data) {
            console.log('[ManicLooping] Transaction successful, stopping animation')
            stopAnimation()
        }
    }, [fulfillIntent.tx.isSuccess, fulfillIntent.tx.data, stopAnimation])

    // Watch for transaction error and stop animation
    useEffect(() => {
        if (fulfillIntent.tx.isError && fulfillIntent.tx.error) {
            console.log('[ManicLooping] Transaction error, stopping animation')
            stopAnimation()
        }
    }, [fulfillIntent.tx.isError, fulfillIntent.tx.error, stopAnimation])

    // Handle boost slider change from Row 2
    const handleBoostChange = (multiplier: number) => {
        setTargetBoostMultiplier(multiplier)
    }

    // Handle apply loop from Row 4
    const handleApplyLoop = async () => {
        console.log('[ManicLooping] Applying loop...', { targetBoostMultiplier })

        // Start animation
        startAnimation()

        // Execute transaction if position exists and simulation is ready
        if (hasPosition && fulfillIntent.simulate.data) {
            try {
                await fulfillIntent.tx.mutateAsync()
            } catch (error) {
                console.error('[ManicLooping] Failed to fulfill intent:', error)
            }
        }
    }

    // Deposit hook
    const depositHook = useManicDeposit({
        amount: depositAmount,
        txSuccess: () => {
            setDepositAmount('')
            setDepositMultiplier(1)
        },
    })

    // Withdraw hook
    const withdrawHook = useManicWithdraw({
        amount: withdrawAmount,
        exitFully: false,
        txSuccess: () => {
            setWithdrawAmount('')
        },
    })

    // Close position hook
    const closeHook = useManicWithdraw({
        exitFully: true,
        txSuccess: () => {
            console.log('Position closed')
        },
    })

    // Handle deposit with multiplier
    const handleDeposit = async (amount: string, multiplier: number) => {
        setDepositAmount(amount)
        setDepositMultiplier(multiplier)
        // The deposit hook will handle the transaction when depositAmount is set
        // Note: In a real implementation, you might want to trigger this via a confirmation modal
        console.log('Depositing:', amount, 'with multiplier:', multiplier)
    }

    // Handle withdraw
    const handleWithdraw = async (amount: string) => {
        setWithdrawAmount(amount)
        // The withdraw hook will handle the transaction when withdrawAmount is set
        console.log('Withdrawing:', amount)
    }

    // Handle close position
    const handleClose = async () => {
        // The close hook is already set up with exitFully: true
        // In a real implementation, you would trigger the transaction here
        console.log('Closing position')
    }

    // Handle loop adjustment
    const handleLoop = async (multiplier: number) => {
        setTargetBoostMultiplier(multiplier)
        // Use existing fulfillIntent for loop adjustments
        handleApplyLoop()
    }

    // =====================
    // DITTO INTEGRATION
    // =====================

    // Ditto page integration - provides context-aware messaging
    const ditto = useDittoPage({
        contract: manicContract,
        facts: {
            // Position facts
            hasDeposit: hasPosition,
            depositAmount: positionEquity,
            collateralAmount,
            debtAmount,

            // Loop facts
            currentLoop: currentLoopLevel,
            targetLoop: targetBoostMultiplier,
            maxSafeLoop: 3, // Conservative default
            loopDisabled,

            // Capacity facts
            loopCapacity: transmuterUSDCBalance,
            capacityRequired,
            capacityPercent: transmuterUSDCBalance > 0
                ? (transmuterUSDCBalance / (globalManicTVL || 1)) * 100
                : 0,

            // APR facts
            baseAPR: aprMetrics.baseAPR,
            userAPR: aprMetrics.userAPR,
            projectedAPR: aprMetrics.baseAPR * targetBoostMultiplier,
            historicalAPR: aprMetrics.baseAPR,

            // Risk facts
            riskScore,
            rateVolatility: 0.05,

            // Transaction facts
            txStatus: fulfillIntent?.tx?.isPending ? 'pending' : 'idle',

            // Connection facts
            isConnected: !!address,
            hasBalance: true,
        },
        onShortcut: (shortcutId: string, action: string) => {
            switch (action) {
                case 'scrollToPosition':
                    positionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                    break
                case 'setMaxSafeLoop':
                    const maxSafe = Math.min(3, transmuterUSDCBalance / (positionEquity || 1) + currentLoopLevel)
                    setTargetBoostMultiplier(Math.max(1, maxSafe))
                    break
                case 'showRatesChart':
                    document.querySelector('[data-chart="market-conditions"]')?.scrollIntoView({
                        behavior: 'smooth',
                        block: 'center'
                    })
                    break
            }
        },
    })

    // Handle loop button click - check for blocked action
    const handleLoopClick = useCallback(() => {
        if (ditto.isActionBlocked('loop')) {
            ditto.reportActionBlocked('loop')
            return
        }
        handleApplyLoop()
    }, [ditto, handleApplyLoop])

    return (
        <Box
            w="100%"
            minH="100vh"
            bg="gray.900"
            py={8}
            px={4}
        >
            <VStack spacing={8} maxW="1400px" mx="auto">
                {/* Header with Boost Card */}
                <HStack w="100%" justify="space-between" align="flex-start" spacing={6}>
                    <Box flex={1}>
                        <Text
                            fontSize={TYPOGRAPHY.h1}
                            fontWeight={TYPOGRAPHY.bold}
                            color="white"
                            fontFamily="mono"
                            textTransform="uppercase"
                            letterSpacing="wide"
                            mb={2}
                        >
                            MANIC LOOPING
                        </Text>
                        <Text
                            fontSize="sm"
                            color="gray.400"
                            fontFamily="mono"
                        >
                            Looped USDC Lending
                        </Text>
                    </Box>
                    {/* Boost Badge - Top Right */}
                    <Box flexShrink={0}>
                        <BoostBreakdown />
                    </Box>
                </HStack>

                {/* ========== ROW 1: Market Context (Global, Non-Personal) ========== */}
                <Grid
                    templateColumns={{ base: '1fr', md: 'repeat(2, 1fr)' }}
                    gap={6}
                    w="100%"
                >
                    {/* Slot 1: VStack with Global Manic TVL and Max APR */}
                    <GridItem>
                        <VStack spacing={4} align="stretch" h="100%" display="flex">
                            <Card
                                bg="gray.800"
                                borderColor="cyan.600"
                                borderWidth="2px"
                                p={4}
                                boxShadow="0 0 20px rgba(72, 187, 120, 0.2)"
                                flex={1}
                                display="flex"
                                flexDirection="column"
                            >
                                <VStack align="start" spacing={2}>
                                    <Text
                                        fontSize="sm"
                                        color="gray.400"
                                        fontFamily="mono"
                                        textTransform="uppercase"
                                    >
                                        Global Manic TVL
                                    </Text>
                                    <Text
                                        fontSize="3xl"
                                        fontWeight="bold"
                                        color="cyan.600"
                                        fontFamily="mono"
                                    >
                                        {globalManicTVL > 0 ? `${globalManicTVL.toFixed(2)} USDC` : '—'}
                                    </Text>
                                </VStack>
                            </Card>
                            <Card
                                bg="gray.800"
                                borderColor="purple.600"
                                borderWidth="2px"
                                p={4}
                                boxShadow="0 0 20px rgba(159, 122, 234, 0.2)"
                                flex={1}
                                display="flex"
                                flexDirection="column"
                            >
                                <VStack align="start" spacing={2}>
                                    <Text
                                        fontSize="sm"
                                        color="gray.400"
                                        fontFamily="mono"
                                        textTransform="uppercase"
                                    >
                                        Max APR
                                    </Text>
                                    <Text
                                        fontSize="3xl"
                                        fontWeight="bold"
                                        color="purple.400"
                                        fontFamily="mono"
                                    >
                                        {aprMetrics.maxAPR.toFixed(2)}%
                                    </Text>
                                </VStack>
                            </Card>
                        </VStack>
                    </GridItem>

                    {/* Slot 2: Compact Boost Simulator */}
                    <GridItem>
                        <Box h="100%" display="flex" alignItems="center">
                            <CompactBoostSimulator
                                baseAPR={aprMetrics.baseAPR}
                                onBoostChange={handleBoostChange}
                            />
                        </Box>
                    </GridItem>
                </Grid>

                <Divider borderColor="gray.700" />

                {/* ========== ROW 2: Unified Position Form ========== */}
                <Box w="100%" ref={positionRef}>
                    <Text
                        fontSize="sm"
                        color="gray.400"
                        fontFamily="mono"
                        textTransform="uppercase"
                        mb={4}
                    >
                        {hasPosition ? 'Your Position' : 'Create Position'}
                    </Text>
                    <UnifiedPositionForm
                        hasPosition={hasPosition}
                        collateralAmount={collateralAmount}
                        debtAmount={debtAmount}
                        currentLoopLevel={currentLoopLevel}
                        userAPR={aprMetrics.userAPR}
                        baseAPR={aprMetrics.baseAPR}
                        transmuterUSDCBalance={transmuterUSDCBalance}
                        funnelFillRatio={funnelFillRatio}
                        onDeposit={handleDeposit}
                        onWithdraw={handleWithdraw}
                        onClose={handleClose}
                        onLoop={handleLoop}
                    />

                    {/* Profit Over Time Chart - Only shown when user has a position */}
                    {hasPosition && (
                        <Card
                            bg="gray.800"
                            borderColor="gray.700"
                            borderWidth="2px"
                            p={6}
                            mt={4}
                        >
                            <Text
                                fontSize="sm"
                                color="gray.400"
                                fontFamily="mono"
                                textTransform="uppercase"
                                mb={2}
                            >
                                Profit Over Time
                            </Text>
                            <ProfitChart
                                data={profitData || []}
                                isLoading={isLoadingProfit}
                            />
                        </Card>
                    )}
                </Box>

                <Divider borderColor="gray.700" />

                {/* ========== ROW 3: Loop Configuration (Stateless Simulator) ========== */}
                <Box w="100%">
                    <Text
                        fontSize="sm"
                        color="gray.400"
                        fontFamily="mono"
                        textTransform="uppercase"
                        mb={4}
                    >
                        Configure Loop
                    </Text>
                    <FlowVisualizer
                        transmuterBalance={transmuterUSDCBalance}
                        baseAPR={aprMetrics.baseAPR}
                        fillRatio={funnelFillRatio}
                        onBoostChange={handleBoostChange}
                        showLoopCapacity={false}
                    />
                </Box>

                {/* ========== ROW 4: Apply/Adjust (Single CTA) ========== */}
                {hasPosition && (
                    <Box w="100%">
                        <ApplyLoopSection
                            hasPosition={hasPosition}
                            targetLoopLevel={targetBoostMultiplier}
                            currentLoopLevel={currentLoopLevel}
                            baseAPR={aprMetrics.baseAPR}
                            collateralAmount={collateralAmount}
                            transmuterBalance={transmuterUSDCBalance}
                            onApplyLoop={handleApplyLoop}
                            isLoading={fulfillIntent.tx.isPending || isManuallyActive}
                        />
                    </Box>
                )}

                <Divider borderColor="gray.700" />

                {/* ========== ROW 5: Historical Market Conditions ========== */}
                <Box w="100%" data-chart="market-conditions">
                    <Text
                        fontSize="sm"
                        color="gray.400"
                        fontFamily="mono"
                        textTransform="uppercase"
                        mb={4}
                    >
                        Historical Market Conditions
                    </Text>
                    <Card
                        bg="gray.800"
                        borderColor="gray.700"
                        borderWidth="2px"
                        p={6}
                    >
                        <MarketConditionsChart
                            data={marketConditions || []}
                            isLoading={isLoadingMarketConditions}
                        />
                    </Card>
                </Box>
            </VStack>
        </Box>
    )
}

export default ManicLooping
