import { useState, useCallback, useMemo } from 'react'
import { num } from '@/helpers/num'
import { useVaultSummary } from '@/components/Mint/hooks/useVaultSummary'
import { useUserPositions } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { getPositions } from '@/services/cdp'
import { useChainRoute } from '@/hooks/useChainRoute'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { getMockBorrowData } from '../mockBorrowData'
import { stableSymbols } from '@/config/defaults'
import { USE_MOCK_DATA } from '../devConfig'

interface UseDepositModalProps {
    positionIndex?: number
    asset: {
        symbol: string
        denom: string
        logo: string
        price: number
    }
}

export const useDepositModal = ({ positionIndex = 0, asset }: UseDepositModalProps) => {
    const [depositAmount, setDepositAmount] = useState<number>(0)
    const [sliderValue, setSliderValue] = useState<number>(0)
    const { chainName } = useChainRoute()

    // Use mock data if enabled
    const mockData = USE_MOCK_DATA ? getMockBorrowData() : null
    const { data: vaultSummary } = useVaultSummary({ positionNumber: positionIndex + 1 })
    const { data: basketPositions } = useUserPositions()
    const { data: prices } = useOraclePrice()

    const finalVaultSummary = mockData?.vaultSummary || vaultSummary
    const finalBasketPositions = mockData?.basketPositions || basketPositions
    const finalPrices = mockData?.prices || prices

    // Wallet balance of the selected asset
    const assetData = useAssetBySymbol(asset.symbol)
    const walletBalanceRaw = useBalanceByAsset(assetData ?? null)
    const walletBalance = useMemo(() => parseFloat(walletBalanceRaw) || 0, [walletBalanceRaw])

    // Current position values (same formula as useBorrowModal/useRepayModal)
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

        // TODO(evm-migration): getPositions is a CosmWasm-shape transform needing the basket
        // aggregate (stubbed in services/chain/cdp.ts); useUserPositions now returns
        // EvmUserPosition[] it cannot consume, so collateral positions are unavailable until a
        // Collateral service exists. Honest empty list — do not invent collateral value.
        const positions: any[] = []
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

    // Projected position after deposit (collateral increases, debt stays same)
    const projectedPosition = useMemo(() => {
        if (depositAmount <= 0) return currentPosition

        const addedValue = num(depositAmount).times(asset.price).toNumber()
        const newCollateralValue = num(currentPosition.collateralValue).plus(addedValue).toNumber()
        const newNetWorth = num(newCollateralValue).minus(currentPosition.debtAmount).toNumber()
        const equity = Math.max(0.01, newNetWorth)
        const newLeverage = newCollateralValue > 0
            ? num(newCollateralValue).dividedBy(equity).toNumber()
            : 1

        const newLtv = newCollateralValue > 0
            ? num(currentPosition.debtAmount).dividedBy(newCollateralValue).times(100).toNumber()
            : 0
        const newHealth = currentPosition.liquidationLTV > 0
            ? Math.max(0, num(100).minus(num(newLtv).dividedBy(currentPosition.liquidationLTV).times(100)).toNumber())
            : 100

        return {
            ...currentPosition,
            collateralValue: newCollateralValue,
            netWorth: newNetWorth,
            leverage: newLeverage,
            health: newHealth,
            ltv: newLtv,
        }
    }, [depositAmount, currentPosition, asset.price])

    // Liquidation data (same logic as BorrowModal/RepayModal)
    const liquidationData = useMemo(() => {
        if (!finalBasketPositions || !finalPrices) {
            return { type: 'threshold' as const, value: 0 }
        }

        // TODO(evm-migration): see note above — collateral positions unavailable until a
        // Collateral service backs the basket. Honest empty list.
        const positions: any[] = []
        const activePositions = positions.filter(p => p && num(p.amount).isGreaterThan(0))

        if (activePositions.length === 0 || projectedPosition.debtAmount <= 0) {
            return { type: 'threshold' as const, value: 0 }
        }

        // For deposit, the collateral amount of the deposited asset increases
        const depositedAssetAmount = depositAmount > 0 ? depositAmount : 0

        if (activePositions.length === 1) {
            const position = activePositions[0]
            const currentPrice = (position as any).assetPrice || 0
            const liquidationLTV = currentPosition.liquidationLTV || 0

            if (currentPrice > 0 && liquidationLTV > 0) {
                const totalAmount = num(position.amount).plus(
                    position.denom === asset.denom ? depositedAssetAmount : 0
                ).toNumber()
                const liquidationPrice = num(projectedPosition.debtAmount)
                    .dividedBy(num(totalAmount).times(liquidationLTV).dividedBy(100))
                    .toNumber()

                return {
                    type: 'price' as const,
                    value: liquidationPrice,
                    symbol: position.symbol || 'Asset',
                }
            }
        }

        if (activePositions.length === 2) {
            const volatilePos = activePositions.find(p => !stableSymbols.includes(p.symbol || ''))
            const stablePos = activePositions.find(p => stableSymbols.includes(p.symbol || ''))

            if (volatilePos && stablePos) {
                const liquidationLTV = currentPosition.liquidationLTV || 0

                if (liquidationLTV > 0) {
                    const stableAmount = num(stablePos.amount).plus(
                        stablePos.denom === asset.denom ? depositedAssetAmount : 0
                    ).toNumber()
                    const stableValue = num(stableAmount).times((stablePos as any).assetPrice || 1).toNumber()

                    const volatileAmount = num(volatilePos.amount).plus(
                        volatilePos.denom === asset.denom ? depositedAssetAmount : 0
                    ).toNumber()

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

        // Multiple collateral: show threshold
        const liquidationLTV = currentPosition.liquidationLTV || 0
        if (liquidationLTV > 0 && projectedPosition.collateralValue > 0) {
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
    }, [finalBasketPositions, finalPrices, positionIndex, chainName, currentPosition, projectedPosition, depositAmount, asset.denom])

    // Handlers
    const handleAmountChange = useCallback((amount: number) => {
        const clampedAmount = Math.max(0, Math.min(amount, walletBalance))
        setDepositAmount(amount) // Allow typing above balance but show error
        if (walletBalance > 0) {
            setSliderValue(Math.min(100, (clampedAmount / walletBalance) * 100))
        }
    }, [walletBalance])

    const handleSliderChange = useCallback((value: number) => {
        setSliderValue(value)
        const amount = num(walletBalance).times(value).dividedBy(100).toNumber()
        setDepositAmount(parseFloat(amount.toFixed(6)))
    }, [walletBalance])

    const handleMaxClick = useCallback(() => {
        setDepositAmount(walletBalance)
        setSliderValue(100)
    }, [walletBalance])

    const reset = useCallback(() => {
        setDepositAmount(0)
        setSliderValue(0)
    }, [])

    return {
        // State
        depositAmount,
        sliderValue,

        // Computed
        walletBalance,
        currentPosition,
        projectedPosition,
        liquidationData,

        // Handlers
        handleAmountChange,
        handleSliderChange,
        handleMaxClick,
        reset,
    }
}
