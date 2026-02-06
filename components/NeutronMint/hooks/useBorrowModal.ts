import { useState, useCallback, useMemo } from 'react'
import { num } from '@/helpers/num'
import { useVaultSummary } from '@/components/Mint/hooks/useVaultSummary'
import { useUserPositions } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { getPositions } from '@/services/cdp'
import { useChainRoute } from '@/hooks/useChainRoute'
import { getMockBorrowData } from '../mockBorrowData'

// Set to true to use mock data for testing the borrow modal
// Change this to `true` to enable mock data
const USE_MOCK_DATA = process.env.NODE_ENV === 'development' && true

export type BorrowRate = 'variable' | 'fixed-1m' | 'fixed-3m' | 'fixed-6m'

interface UseBorrowModalProps {
    positionIndex?: number
    asset: {
        symbol: 'CDT' | 'USDC'
        denom: string
        price: number
    }
}

export const useBorrowModal = ({ positionIndex = 0, asset }: UseBorrowModalProps) => {
    const [selectedRate, setSelectedRate] = useState<BorrowRate>('variable')
    const [borrowAmount, setBorrowAmount] = useState<number>(0)
    const [receiveToWallet, setReceiveToWallet] = useState<boolean>(true)
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

    // Calculate max borrowable
    const maxBorrowable = useMemo(() => {
        if (!finalVaultSummary) return 0
        const { maxMint = 0, debtAmount = 0 } = finalVaultSummary
        const available = num(maxMint).minus(debtAmount).toNumber()
        return Math.max(0, available)
    }, [finalVaultSummary])

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
        const equity = Math.max(0.01, netWorth) // Avoid division by zero
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

    // Calculate projected position after borrow
    const projectedPosition = useMemo(() => {
        if (borrowAmount <= 0) return currentPosition

        const newDebtAmount = num(currentPosition.debtAmount).plus(borrowAmount).toNumber()
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
    }, [borrowAmount, currentPosition])

    // Handle rate change (preserves amount)
    const handleRateChange = useCallback((rate: BorrowRate) => {
        setSelectedRate(rate)
        // Amount is preserved - no reset
    }, [])

    // Handle amount change
    const handleAmountChange = useCallback((amount: number) => {
        const clampedAmount = Math.max(0, Math.min(amount, maxBorrowable))
        setBorrowAmount(clampedAmount)

        // Update slider value based on amount (0-100 scale)
        if (maxBorrowable > 0) {
            const sliderPercent = num(clampedAmount).dividedBy(maxBorrowable).times(100).toNumber()
            setSliderValue(Math.min(100, Math.max(0, sliderPercent)))
        } else {
            setSliderValue(0)
        }
    }, [maxBorrowable])

    // Handle slider change
    const handleSliderChange = useCallback((value: number) => {
        setSliderValue(value)
        // Calculate amount from slider (0-100 scale)
        const amount = num(maxBorrowable).times(value).dividedBy(100).toNumber()
        setBorrowAmount(amount)
    }, [maxBorrowable])

    // Handle max click
    const handleMaxClick = useCallback(() => {
        handleAmountChange(maxBorrowable)
    }, [maxBorrowable, handleAmountChange])

    // Reset modal state
    const reset = useCallback(() => {
        setSelectedRate('variable')
        setBorrowAmount(0)
        setReceiveToWallet(true)
        setSliderValue(0)
    }, [])

    return {
        // State
        selectedRate,
        borrowAmount,
        receiveToWallet,
        sliderValue,

        // Computed values
        maxBorrowable,
        currentPosition,
        projectedPosition,

        // Handlers
        handleRateChange,
        handleAmountChange,
        handleSliderChange,
        handleMaxClick,
        setReceiveToWallet,
        reset,
    }
}

