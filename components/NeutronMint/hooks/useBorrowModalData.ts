import { useMemo, useEffect, useCallback } from 'react'
import { num } from '@/helpers/num'
import { useBorrowModal, type BorrowRate } from './useBorrowModal'
import { useBorrowRates } from './useBorrowRates'
import { useBorrowTransaction } from './useBorrowTransaction'
import { debtDeltaMessage } from '../positionDelta'
import { useFixedRateCaps, remainingFixedCapacity } from './useFixedRateCaps'
import { useUserPositions } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { getPositions } from '@/services/cdp'
import { useChainRoute } from '@/hooks/useChainRoute'
import { getMockBorrowData } from '../mockBorrowData'
import { stableSymbols } from '@/config/defaults'
import { useTransmuterTVL } from '@/hooks/useTransmuterData'
import { shiftDigits } from '@/helpers/math'
import { USE_MOCK_DATA } from '../devConfig'

export interface BorrowModalAsset {
    symbol: 'CDT' | 'USDC'
    denom: string
    logo: string
    price: number
}

interface UseBorrowModalDataProps {
    isOpen: boolean
    onClose: () => void
    asset: BorrowModalAsset
    positionIndex: number
}

/**
 * Data + derived-state hook backing BorrowModal. Owns all data fetching, memoized
 * derivations (display rates, fixed-rate cap, position/debt/liquidation previews) and the
 * borrow transaction wiring so the modal component stays presentational. Behavior is
 * identical to the prior in-component logic — memo deps and formulas are unchanged.
 */
export const useBorrowModalData = ({
    isOpen,
    onClose,
    asset,
    positionIndex,
}: UseBorrowModalDataProps) => {
    const { chainName } = useChainRoute()

    // Use mock data if enabled, otherwise use real hooks
    const mockData = USE_MOCK_DATA ? getMockBorrowData() : null
    const { data: basketPositions } = useUserPositions()
    const { data: prices } = useOraclePrice()
    const { data: transmuterTVL } = useTransmuterTVL()

    // Override with mock data if enabled
    const finalBasketPositions = mockData?.basketPositions || basketPositions
    const finalPrices = mockData?.prices || prices

    const borrowModal = useBorrowModal({ positionIndex, asset })
    const rates = useBorrowRates({ assetSymbol: asset.symbol })

    const {
        selectedRate,
        borrowAmount,
        sliderValue,
        maxBorrowable,
        currentPosition,
        projectedPosition,
        handleRateChange,
        handleAmountChange,
        handleSliderChange,
        handleMaxClick,
        reset,
    } = borrowModal

    // Fixed-rate aggregate cap (20% of basket debt) + on-chain bucket multipliers.
    const { data: fixedCaps } = useFixedRateCaps()

    // Reset modal when it closes
    useEffect(() => {
        if (!isOpen) {
            reset()
        }
    }, [isOpen, reset])

    const isFixed = selectedRate !== 'variable'

    // Displayed fixed rate = bucket multiplier × current variable rate (fixed rates are not
    // quoted on-chain). Multipliers come from fixedRateCapsView (fallbacks in the hook).
    const getDisplayRate = useCallback(
        (rate: BorrowRate) => {
            const m = fixedCaps?.multipliers
            switch (rate) {
                case 'fixed-1m':
                    return num(rates.variable).times(m?.oneMonth ?? 1.1).toNumber()
                case 'fixed-3m':
                    return num(rates.variable).times(m?.threeMonth ?? 1.3).toNumber()
                case 'fixed-6m':
                    return num(rates.variable).times(m?.sixMonth ?? 1.7).toNumber()
                default:
                    return rates.variable
            }
        },
        [rates.variable, fixedCaps],
    )

    // Rates surfaced to the selector, with fixed tranches recomputed as multiplier × variable.
    const displayRates = useMemo(
        () => ({
            variable: rates.variable,
            fixed1m: getDisplayRate('fixed-1m'),
            fixed3m: getDisplayRate('fixed-3m'),
            fixed6m: getDisplayRate('fixed-6m'),
        }),
        [rates.variable, getDisplayRate],
    )

    // Remaining fixed-rate capacity (human CDT) before the aggregate cap reverts.
    const fixedCapacity = useMemo(() => remainingFixedCapacity(fixedCaps), [fixedCaps])

    // A fixed borrow that pushes the basket over the 20% aggregate cap will revert
    // FixedRateCapExceeded() — gate the CTA and warn before the user signs.
    const exceedsFixedCap = useMemo(
        () => isFixed && Number.isFinite(fixedCapacity) && borrowAmount > fixedCapacity,
        [isFixed, fixedCapacity, borrowAmount],
    )

    // Get current rate APR (fixed tranches use the multiplier-derived display rate)
    const currentApr = useMemo(() => {
        return getDisplayRate(selectedRate)
    }, [getDisplayRate, selectedRate])

    // Get liquidity available
    // CDT minting is unlimited (-1). USDC liquidity comes from the transmuter pool.
    const liquidityAvailable = useMemo(() => {
        if (asset.symbol === 'CDT') return -1
        // USDC available = transmuter TVL (USDC held in the transmuter pool)
        if (transmuterTVL) {
            return shiftDigits(transmuterTVL, -6).toNumber()
        }
        return 0
    }, [asset.symbol, transmuterTVL])

    // Build position data for preview
    const positionData = useMemo(() => {
        // Calculate current APY (simplified - would need actual calculation)
        const currentApy = currentPosition.collateralValue > 0
            ? num(currentPosition.debtAmount)
                .dividedBy(currentPosition.collateralValue)
                .times(currentApr)
                .toNumber()
            : 0

        const projectedApy = projectedPosition.collateralValue > 0
            ? num(projectedPosition.debtAmount)
                .dividedBy(projectedPosition.collateralValue)
                .times(currentApr)
                .toNumber()
            : 0

        return {
            current: {
                ...currentPosition,
                apy: currentApy,
            },
            projected: {
                ...projectedPosition,
                apy: projectedApy,
            },
        }
    }, [currentPosition, projectedPosition, currentApr])

    // Build debt composition for preview (dynamic based on current debt and borrow input).
    // Note: The CDP contract's BasketPositionsResponse returns only total credit_amount
    // without a per-rate-type breakdown. Until the contract exposes debt-by-rate-type,
    // existing debt is assumed to be Variable rate.
    const debtComposition = useMemo(() => {
        const compositionRows: Array<{
            type: string
            rate: number
            ratio: number
        }> = []

        const totalDebt = projectedPosition.debtAmount
        const existingDebt = currentPosition.debtAmount
        const newBorrow = borrowAmount

        if (totalDebt <= 0) {
            return compositionRows
        }

        // Get rate type label
        const getRateTypeLabel = (rate: BorrowRate) => {
            switch (rate) {
                case 'variable':
                    return 'Variable'
                case 'fixed-1m':
                    return 'Fixed 1-Month'
                case 'fixed-3m':
                    return 'Fixed 3-Month'
                case 'fixed-6m':
                    return 'Fixed 6-Month'
                default:
                    return 'Variable'
            }
        }

        if (existingDebt > 0 && newBorrow === 0) {
            // Only existing debt — contract does not expose rate type, defaulting to Variable
            compositionRows.push({
                type: 'Variable',
                rate: rates.getRate('variable'),
                ratio: 100,
            })
        } else if (existingDebt > 0 && newBorrow > 0) {
            // Existing debt + new borrow
            const existingRatio = num(existingDebt).dividedBy(totalDebt).times(100).toNumber()
            const newRatio = num(newBorrow).dividedBy(totalDebt).times(100).toNumber()

            // If new borrow is also variable, merge them
            if (selectedRate === 'variable') {
                compositionRows.push({
                    type: 'Variable',
                    rate: rates.getRate('variable'),
                    ratio: 100,
                })
            } else {
                // Different rate types - show separately
                // Contract does not expose rate type, defaulting existing debt to Variable
                compositionRows.push({
                    type: 'Variable',
                    rate: rates.getRate('variable'),
                    ratio: existingRatio,
                })
                compositionRows.push({
                    type: getRateTypeLabel(selectedRate),
                    rate: currentApr,
                    ratio: newRatio,
                })
            }
        } else if (newBorrow > 0) {
            // Only new borrow
            compositionRows.push({
                type: getRateTypeLabel(selectedRate),
                rate: currentApr,
                ratio: 100,
            })
        }

        return compositionRows
    }, [currentPosition.debtAmount, projectedPosition.debtAmount, borrowAmount, selectedRate, currentApr, rates])

    // Calculate current Borrow APY (before new borrow)
    const currentBorrowApy = useMemo(() => {
        if (currentPosition.debtAmount <= 0) {
            return 0
        }

        // Contract does not expose per-rate-type debt breakdown, defaulting to Variable
        return rates.getRate('variable')
    }, [currentPosition.debtAmount, rates])

    // Calculate projected Borrow APY (after new borrow)
    const projectedBorrowApy = useMemo(() => {
        if (debtComposition.length === 0) {
            return 0
        }

        // Calculate weighted average: sum of (rate * ratio) / 100
        const weightedSum = debtComposition.reduce((sum, row) => {
            return sum + (row.rate * row.ratio)
        }, 0)

        return weightedSum / 100
    }, [debtComposition])

    // Calculate liquidation data
    const liquidationData = useMemo(() => {
        if (!finalBasketPositions || !finalPrices) {
            return { type: 'threshold' as const, value: 0 }
        }

        const positions = getPositions(finalBasketPositions, finalPrices, positionIndex, chainName) || []
        const activePositions = positions.filter(p => p && num(p.amount).isGreaterThan(0))

        if (activePositions.length === 0) {
            return { type: 'threshold' as const, value: 0 }
        }

        // Check if single collateral
        if (activePositions.length === 1) {
            const position = activePositions[0]
            const currentPrice = position.assetPrice || 0
            const liquidationLTV = currentPosition.liquidationLTV || 0

            if (currentPrice > 0 && liquidationLTV > 0 && projectedPosition.debtAmount > 0) {
                // Liquidation price = (debt / (collateral_amount * liquidation_ltv)) * current_price
                const collateralAmount = position.amount
                const liquidationPrice = num(projectedPosition.debtAmount)
                    .dividedBy(num(collateralAmount).times(liquidationLTV).dividedBy(100))
                    .toNumber()

                return {
                    type: 'price' as const,
                    value: liquidationPrice,
                    symbol: position.symbol || 'Asset',
                }
            }
        }

        // Check if 1 volatile + 1 stable
        // js-set-map-lookups FP: stableSymbols is a hardcoded 3-item list (config/defaults.ts)
        // and this branch only ever runs with exactly 2 activePositions — well under the
        // ~10-item threshold where a Set pays off.
        if (activePositions.length === 2) {
            const volatilePos = activePositions.find(p => !stableSymbols.includes(p.symbol || ''))
            const stablePos = activePositions.find(p => stableSymbols.includes(p.symbol || ''))

            if (volatilePos && stablePos) {
                const currentPrice = volatilePos.assetPrice || 0
                const liquidationLTV = currentPosition.liquidationLTV || 0

                if (currentPrice > 0 && liquidationLTV > 0 && projectedPosition.debtAmount > 0) {
                    // For 1 volatile + stable: liquidation price of the volatile asset
                    // Total collateral value = volatile_value + stable_value
                    // At liquidation: volatile_value * (liquidation_ltv/100) + stable_value = debt
                    // So: volatile_price * volatile_amount * (liquidation_ltv/100) = debt - stable_value
                    // Therefore: volatile_price = (debt - stable_value) / (volatile_amount * liquidation_ltv/100)
                    const stableValue = stablePos.usdValue || 0
                    const volatileAmount = volatilePos.amount
                    const debtMinusStable = Math.max(0, num(projectedPosition.debtAmount).minus(stableValue).toNumber())

                    if (debtMinusStable > 0 && volatileAmount > 0) {
                        const liquidationPrice = num(debtMinusStable)
                            .dividedBy(num(volatileAmount).times(liquidationLTV).dividedBy(100))
                            .toNumber()

                        return {
                            type: 'price' as const,
                            value: liquidationPrice,
                            symbol: volatilePos.symbol || 'Asset',
                        }
                    }
                }
            }
        }

        // For multiple collateral positions, show liquidation threshold
        const liquidationLTV = currentPosition.liquidationLTV || 0
        if (liquidationLTV > 0 && projectedPosition.collateralValue > 0) {
            // Liquidation threshold = collateral_value * (liquidation_ltv / 100)
            const threshold = num(projectedPosition.collateralValue)
                .times(liquidationLTV)
                .dividedBy(100)
                .toNumber()

            return {
                type: 'threshold' as const,
                value: threshold,
            }
        }

        return { type: 'threshold' as const, value: 0 }
    }, [finalBasketPositions, finalPrices, positionIndex, chainName, currentPosition, projectedPosition])

    // Transaction hook
    const borrowTransaction = useBorrowTransaction({
        asset,
        borrowAmount,
        selectedRate,
        positionIndex,
        enabled: isOpen && borrowAmount > 0 && !exceedsFixedCap,
        // The delta the user just previewed, restated as the outcome (real values:
        // debt from vault summary plus their own borrow amount).
        successMessage: debtDeltaMessage(currentPosition.debtAmount, projectedPosition.debtAmount),
        onSuccess: () => {
            onClose()
            reset()
        },
    })

    const isLoading = borrowTransaction?.simulate.isLoading || borrowTransaction?.tx.isPending
    const isDisabled = borrowAmount <= 0 || exceedsFixedCap || borrowTransaction?.simulate.isError || !borrowTransaction?.simulate.data

    return {
        // State
        selectedRate,
        borrowAmount,
        sliderValue,
        maxBorrowable,

        // Handlers
        handleRateChange,
        handleAmountChange,
        handleSliderChange,
        handleMaxClick,

        // Derived values
        isFixed,
        displayRates,
        liquidityAvailable,
        fixedCapacity,
        exceedsFixedCap,
        positionData,
        debtComposition,
        currentBorrowApy,
        projectedBorrowApy,
        liquidationData,

        // Transaction
        borrowTransaction,
        isLoading,
        isDisabled,
    }
}
