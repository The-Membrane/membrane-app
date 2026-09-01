import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useManicData, useMarketConditions, useDeploymentProfitData } from '@/hooks/useManic'
import { useFlywheelMetrics } from '@/hooks/useFlywheelMetrics'
import { shiftDigits } from '@/helpers/math'
import useFulfillIntent from './useFulfillIntent'
import { useLoopAnimationState } from './useLoopAnimationState'
import { useDittoPage } from '@/components/DittoSpeechBox/hooks/useDittoPage'
import { manicContract } from '@/contracts/manicContract'
import useWallet from '@/hooks/useWallet'
import useManicDeposit from './useManicDeposit'
import useManicWithdraw from './useManicWithdraw'

// Handle close position
const handleClose = async () => {
    // The close hook is already set up with exitFully: true
    // In a real implementation, you would trigger the transaction here
    console.log('Closing position')
}

/**
 * useManicLooping
 *
 * Encapsulates all state, data fetching, derived metrics, transaction hooks,
 * effects, handlers and Ditto page integration for the ManicLooping screen.
 * Extracted verbatim from the ManicLooping component so the view layer can be
 * split into focused presentational subcomponents.
 */
export const useManicLooping = () => {
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
    const handleApplyLoop = useCallback(async () => {
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
    }, [targetBoostMultiplier, startAnimation, hasPosition, fulfillIntent])

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
    // Memoize the facts object so it isn't rebuilt every render: useDittoPage
    // consumes `facts` inside effects (prevFacts tracking / messageEngine), so a
    // fresh object each render would destabilize those downstream Hooks.
    const dittoFacts = useMemo(() => ({
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
    }), [hasPosition, positionEquity, collateralAmount, debtAmount, currentLoopLevel, targetBoostMultiplier, loopDisabled, transmuterUSDCBalance, capacityRequired, globalManicTVL, aprMetrics.baseAPR, aprMetrics.userAPR, riskScore, fulfillIntent?.tx?.isPending, address])

    const ditto = useDittoPage({
        contract: manicContract,
        facts: dittoFacts,
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

    return {
        positionRef,
        targetBoostMultiplier,
        globalManicTVL,
        transmuterUSDCBalance,
        collateralAmount,
        debtAmount,
        currentLoopLevel,
        hasPosition,
        funnelFillRatio,
        aprMetrics,
        marketConditions,
        isLoadingMarketConditions,
        profitData,
        isLoadingProfit,
        isManuallyActive,
        fulfillIntent,
        handleBoostChange,
        handleApplyLoop,
        handleDeposit,
        handleWithdraw,
        handleClose,
        handleLoop,
    }
}

export default useManicLooping
