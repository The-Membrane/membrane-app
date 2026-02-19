import { useState, useCallback, useMemo } from 'react'
import { num } from '@/helpers/num'
import { useVaultSummary } from '@/components/Mint/hooks/useVaultSummary'
import { useUserPositions } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { getPositions } from '@/services/cdp'
import { useChainRoute } from '@/hooks/useChainRoute'
import { getMockBorrowData } from '../mockBorrowData'

// Set to true to use mock data for testing the repay modal
const USE_MOCK_DATA = process.env.NODE_ENV === 'development' && true

interface UseRepayModalProps {
    positionIndex?: number
}

export const useRepayModal = ({ positionIndex = 0 }: UseRepayModalProps) => {
    const [repayAmount, setRepayAmount] = useState<number>(0)
    const [sliderValue, setSliderValue] = useState<number>(0)
    const { chainName } = useChainRoute()

    // Use mock data if enabled, otherwise use real hooks
    const mockData = USE_MOCK_DATA ? getMockBorrowData() : null
    const { data: vaultSummary } = useVaultSummary({ positionNumber: positionIndex + 1 })
    const { data: basketPositions } = useUserPositions()
    const { data: prices } = useOraclePrice()

    // Override with mock data if enabled
    const finalVaultSummary = mockData?.vaultSummary || vaultSummary
    const finalBasketPositions = mockData?.basketPositions || basketPositions
    const finalPrices = mockData?.prices || prices

    // Current debt amount
    const currentDebt = useMemo(() => {
        if (!finalVaultSummary) return 0
        return finalVaultSummary.debtAmount || 0
    }, [finalVaultSummary])

    // Max repayable is the total debt (user needs CDT in wallet, but we cap at debt)
    const maxRepayable = useMemo(() => {
        return Math.max(0, currentDebt)
    }, [currentDebt])

    // Calculate current position values
    const currentPosition = useMemo(() => {
        if (!finalBasketPositions || !finalPrices || !finalVaultSummary) {
            return {
                collateralValue: 0,
                debtAmount: 0,
                netWorth: 0,
                leverage: 1,
                health: 100,
                ltv: 0,
                liquidationLTV: 0,
            }
        }

        const positions = getPositions(finalBasketPositions, finalPrices, positionIndex, chainName) || []
        const collateralValue = positions.reduce((sum, p) => sum + (p?.usdValue || 0), 0)
        const debtAmount = finalVaultSummary.debtAmount || 0
        const netWorth = num(collateralValue).minus(debtAmount).toNumber()
        const equity = Math.max(0.01, netWorth)
        const leverage = collateralValue > 0 ? num(collateralValue).dividedBy(equity).toNumber() : 1

        const ltv = collateralValue > 0
            ? num(debtAmount).dividedBy(collateralValue).times(100).toNumber()
            : 0
        const liquidationLTV = finalVaultSummary.liqudationLTV || 0
        const health = liquidationLTV > 0
            ? Math.max(0, num(100).minus(num(ltv).dividedBy(liquidationLTV).times(100)).toNumber())
            : 100

        return {
            collateralValue,
            debtAmount,
            netWorth,
            leverage,
            health,
            ltv,
            liquidationLTV,
        }
    }, [finalBasketPositions, finalPrices, finalVaultSummary, positionIndex, chainName])

    // Calculate projected position after repay (debt decreases, health improves)
    const projectedPosition = useMemo(() => {
        if (repayAmount <= 0) return currentPosition

        const newDebtAmount = Math.max(0, num(currentPosition.debtAmount).minus(repayAmount).toNumber())
        const newNetWorth = num(currentPosition.collateralValue).minus(newDebtAmount).toNumber()
        const equity = Math.max(0.01, newNetWorth)
        const newLeverage = currentPosition.collateralValue > 0
            ? num(currentPosition.collateralValue).dividedBy(equity).toNumber()
            : 1

        const newLtv = currentPosition.collateralValue > 0
            ? num(newDebtAmount).dividedBy(currentPosition.collateralValue).times(100).toNumber()
            : 0
        const newHealth = currentPosition.liquidationLTV > 0
            ? Math.max(0, num(100).minus(num(newLtv).dividedBy(currentPosition.liquidationLTV).times(100)).toNumber())
            : 100

        return {
            ...currentPosition,
            debtAmount: newDebtAmount,
            netWorth: newNetWorth,
            leverage: newLeverage,
            health: newHealth,
            ltv: newLtv,
        }
    }, [repayAmount, currentPosition])

    // Handle amount change
    const handleAmountChange = useCallback((amount: number) => {
        const clampedAmount = Math.max(0, Math.min(amount, maxRepayable))
        setRepayAmount(clampedAmount)

        if (maxRepayable > 0) {
            const sliderPercent = num(clampedAmount).dividedBy(maxRepayable).times(100).toNumber()
            setSliderValue(Math.min(100, Math.max(0, sliderPercent)))
        } else {
            setSliderValue(0)
        }
    }, [maxRepayable])

    // Handle slider change
    const handleSliderChange = useCallback((value: number) => {
        setSliderValue(value)
        const amount = num(maxRepayable).times(value).dividedBy(100).toNumber()
        setRepayAmount(amount)
    }, [maxRepayable])

    // Handle max click
    const handleMaxClick = useCallback(() => {
        handleAmountChange(maxRepayable)
    }, [maxRepayable, handleAmountChange])

    // Reset modal state
    const reset = useCallback(() => {
        setRepayAmount(0)
        setSliderValue(0)
    }, [])

    return {
        // State
        repayAmount,
        sliderValue,

        // Computed values
        maxRepayable,
        currentDebt,
        currentPosition,
        projectedPosition,

        // Handlers
        handleAmountChange,
        handleSliderChange,
        handleMaxClick,
        reset,
    }
}
