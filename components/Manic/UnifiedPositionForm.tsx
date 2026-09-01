import React, { useState, useMemo, ChangeEvent } from 'react'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useChainRoute } from '@/hooks/useChainRoute'
import { num } from '@/helpers/num'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { CreatePositionForm } from './CreatePositionForm'
import { AdjustPositionForm } from './AdjustPositionForm'

interface UnifiedPositionFormProps {
    // Position state
    hasPosition: boolean
    collateralAmount: number
    debtAmount: number
    currentLoopLevel: number
    userAPR: number

    // Market data
    baseAPR: number
    transmuterUSDCBalance: number
    funnelFillRatio: number

    // Callbacks
    onDeposit: (amount: string, boostMultiplier: number) => void
    onWithdraw?: (amount: string) => void
    onClose?: () => void
    onLoop?: (boostMultiplier: number) => void
}

export const UnifiedPositionForm: React.FC<UnifiedPositionFormProps> = ({
    hasPosition,
    collateralAmount,
    debtAmount,
    currentLoopLevel,
    userAPR,
    baseAPR,
    transmuterUSDCBalance,
    funnelFillRatio,
    onDeposit,
    onWithdraw,
    onClose,
    onLoop,
}) => {
    const { chainName } = useChainRoute()
    const usdcAsset = useAssetBySymbol('USDC', chainName)
    const usdcBalance = useBalanceByAsset(usdcAsset)

    const [depositAmount, setDepositAmount] = useState('')
    const [withdrawAmount, setWithdrawAmount] = useState('')
    const [boostMultiplier, setBoostMultiplier] = useState(hasPosition ? currentLoopLevel : 1)
    const [activeTab, setActiveTab] = useState(0)

    // Calculate max deposit based on capacity (capacity / 10 for 10x max loop)
    const maxDeposit = useMemo(() => {
        const capacityBasedMax = transmuterUSDCBalance / 10
        const walletBalance = Number(usdcBalance)
        return Math.min(capacityBasedMax, walletBalance)
    }, [transmuterUSDCBalance, usdcBalance])

    // Calculate current equity (for withdraw max)
    const currentEquity = useMemo(() => {
        if (!hasPosition) return 0
        return Math.max(0, collateralAmount - debtAmount)
    }, [hasPosition, collateralAmount, debtAmount])

    // Calculate current LTV
    const currentLTV = useMemo(() => {
        if (!hasPosition || collateralAmount <= 0) return 0
        return (debtAmount / collateralAmount) * 100
    }, [hasPosition, collateralAmount, debtAmount])

    // Health indicator — phosphor / gold / blood
    const healthColor = useMemo(() => {
        if (currentLTV < 60) return SEMANTIC_COLORS.success
        if (currentLTV < 80) return SEMANTIC_COLORS.warning
        return SEMANTIC_COLORS.danger
    }, [currentLTV])

    const healthLabel = useMemo(() => {
        if (currentLTV < 60) return 'Healthy'
        if (currentLTV < 80) return 'Moderate'
        return 'At Risk'
    }, [currentLTV])

    // Calculate required capacity
    const requiredCapacity = useMemo(() => {
        if (!hasPosition) {
            // For new position: amount * (multiplier - 1) * 0.9 (LTV)
            const amount = parseFloat(depositAmount) || 0
            if (amount <= 0) return 0
            return amount * (boostMultiplier - 1) * 0.9
        } else {
            // For loop adjustment on existing position
            if (boostMultiplier <= currentLoopLevel) return 0
            const additionalDebt = collateralAmount * (boostMultiplier - currentLoopLevel)
            return additionalDebt
        }
    }, [depositAmount, boostMultiplier, hasPosition, collateralAmount, currentLoopLevel])

    // Calculate projected APR
    const projectedAPR = baseAPR * boostMultiplier

    // Handle deposit amount change
    const handleDepositAmountChange = (e: ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value
        if (value === '' || /^\d*\.?\d*$/.test(value)) {
            setDepositAmount(value)
        }
    }

    // Handle withdraw amount change
    const handleWithdrawAmountChange = (e: ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value
        if (value === '' || /^\d*\.?\d*$/.test(value)) {
            setWithdrawAmount(value)
        }
    }

    // Handle boost multiplier change
    const handleBoostChange = (val: number) => {
        setBoostMultiplier(val)
    }

    // Handle boost multiplier input change
    const handleBoostInputChange = (e: ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value
        if (value === '' || /^\d*\.?\d*$/.test(value)) {
            const numValue = parseFloat(value)
            if (!isNaN(numValue) && numValue >= 1 && numValue <= 10) {
                setBoostMultiplier(numValue)
            }
        }
    }

    // Handle max deposit click
    const handleMaxDepositClick = () => {
        setDepositAmount(maxDeposit.toString())
    }

    // Handle max withdraw click
    const handleMaxWithdrawClick = () => {
        setWithdrawAmount(currentEquity.toString())
    }

    // Validation
    const isValidDeposit = useMemo(() => {
        const amount = parseFloat(depositAmount) || 0
        return amount > 0 &&
               amount <= Number(usdcBalance) &&
               amount <= maxDeposit &&
               requiredCapacity <= transmuterUSDCBalance
    }, [depositAmount, usdcBalance, maxDeposit, requiredCapacity, transmuterUSDCBalance])

    const isValidWithdraw = useMemo(() => {
        const amount = parseFloat(withdrawAmount) || 0
        return amount > 0 && amount <= currentEquity
    }, [withdrawAmount, currentEquity])

    const isValidLoop = useMemo(() => {
        if (!hasPosition) return false
        return boostMultiplier > currentLoopLevel &&
               requiredCapacity <= transmuterUSDCBalance
    }, [hasPosition, boostMultiplier, currentLoopLevel, requiredCapacity, transmuterUSDCBalance])

    // Handle submit
    const handleDepositSubmit = () => {
        if (isValidDeposit) {
            onDeposit(depositAmount, boostMultiplier)
            setDepositAmount('')
            setBoostMultiplier(1)
        }
    }

    const handleWithdrawSubmit = () => {
        if (isValidWithdraw && onWithdraw) {
            onWithdraw(withdrawAmount)
            setWithdrawAmount('')
        }
    }

    const handleCloseSubmit = () => {
        if (onClose) {
            onClose()
        }
    }

    const handleLoopSubmit = () => {
        if (isValidLoop && onLoop) {
            onLoop(boostMultiplier)
        }
    }

    const usdDepositValue = num(depositAmount || 0).times(1).toFixed(2)
    const usdWithdrawValue = num(withdrawAmount || 0).times(1).toFixed(2)

    // No Position State - Deposit Form
    if (!hasPosition) {
        return (
            <CreatePositionForm
                usdcAsset={usdcAsset}
                usdcBalance={usdcBalance}
                depositAmount={depositAmount}
                handleDepositAmountChange={handleDepositAmountChange}
                usdDepositValue={usdDepositValue}
                maxDeposit={maxDeposit}
                handleMaxDepositClick={handleMaxDepositClick}
                boostMultiplier={boostMultiplier}
                handleBoostInputChange={handleBoostInputChange}
                handleBoostChange={handleBoostChange}
                baseAPR={baseAPR}
                projectedAPR={projectedAPR}
                funnelFillRatio={funnelFillRatio}
                transmuterUSDCBalance={transmuterUSDCBalance}
                requiredCapacity={requiredCapacity}
                isValidDeposit={isValidDeposit}
                handleDepositSubmit={handleDepositSubmit}
            />
        )
    }

    // Has Position State - Adjust Position Form
    return (
        <AdjustPositionForm
            collateralAmount={collateralAmount}
            currentLoopLevel={currentLoopLevel}
            userAPR={userAPR}
            healthColor={healthColor}
            healthLabel={healthLabel}
            currentLTV={currentLTV}
            debtAmount={debtAmount}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            usdcAsset={usdcAsset}
            usdcBalance={usdcBalance}
            depositAmount={depositAmount}
            handleDepositAmountChange={handleDepositAmountChange}
            usdDepositValue={usdDepositValue}
            maxDeposit={maxDeposit}
            handleMaxDepositClick={handleMaxDepositClick}
            isValidDeposit={isValidDeposit}
            handleDepositSubmit={handleDepositSubmit}
            withdrawAmount={withdrawAmount}
            handleWithdrawAmountChange={handleWithdrawAmountChange}
            usdWithdrawValue={usdWithdrawValue}
            currentEquity={currentEquity}
            handleMaxWithdrawClick={handleMaxWithdrawClick}
            isValidWithdraw={isValidWithdraw}
            handleWithdrawSubmit={handleWithdrawSubmit}
            boostMultiplier={boostMultiplier}
            handleBoostInputChange={handleBoostInputChange}
            handleBoostChange={handleBoostChange}
            projectedAPR={projectedAPR}
            funnelFillRatio={funnelFillRatio}
            transmuterUSDCBalance={transmuterUSDCBalance}
            requiredCapacity={requiredCapacity}
            isValidLoop={isValidLoop}
            handleLoopSubmit={handleLoopSubmit}
            handleCloseSubmit={handleCloseSubmit}
        />
    )
}
