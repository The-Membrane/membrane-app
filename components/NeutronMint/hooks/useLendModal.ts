import { useState, useCallback, useMemo } from 'react'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useAcquisitionConfig, useAcquisition } from '@/hooks/useAcquisition'
import { useTransmuterTVL } from '@/hooks/useTransmuterData'
import { useMostProfitableSlot5 } from '@/hooks/useMostProfitableSlot5'
import { num } from '@/helpers/num'
import { shiftDigits } from '@/helpers/math'

export const useLendModal = () => {
  const [depositAmount, setDepositAmount] = useState(0)
  const [sliderValue, setSliderValue] = useState(0)

  // No locks — lockDays is fixed at 0 for the deposit message
  const lockDays = 0

  // Data hooks
  const usdcAsset = useAssetBySymbol('USDC')
  const walletBalance = useBalanceByAsset(usdcAsset ?? null)
  const { data: acquisitionConfig } = useAcquisitionConfig()
  const { totalPoints: existingTotalPoints } = useAcquisition()
  const { data: tvlRaw } = useTransmuterTVL()
  const { data: mostProfitableSlot5 } = useMostProfitableSlot5()

  const walletBalanceNum = useMemo(() => {
    return parseFloat(walletBalance) || 0
  }, [walletBalance])

  // Acquisition model
  const acquisitionModel = useMemo(() => {
    const model = acquisitionConfig?.acquisition_model
    const maxMbrn = model?.max_mbrn_emission
      ? num(model.max_mbrn_emission).div(1e6).toNumber()
      : 0
    const accrualRate = model?.base_acquisition_rate
      ? num(model.base_acquisition_rate).toNumber()
      : 0
    const tvl = tvlRaw ? shiftDigits(tvlRaw, -6).toNumber() : 0
    const rewardRate = tvl > 0 ? maxMbrn / tvl : 0

    return { maxMbrn, accrualRate, rewardRate, tvl }
  }, [acquisitionConfig, tvlRaw])

  // Points calculation: deposit * 1 (no lock multiplier)
  const projectedPoints = useMemo(() => {
    if (depositAmount <= 0) return 0
    return depositAmount
  }, [depositAmount])

  // Pro-rata share of total rewards
  const projectedShare = useMemo(() => {
    if (projectedPoints <= 0) return 0
    const totalAfter = existingTotalPoints + projectedPoints
    if (totalAfter <= 0) return 0
    return projectedPoints / totalAfter
  }, [projectedPoints, existingTotalPoints])

  // Projected MBRN allocation
  const projectedMbrn = projectedShare * acquisitionModel.maxMbrn

  // Handlers
  const handleAmountChange = useCallback((value: number) => {
    const clamped = Math.max(0, Math.min(value, walletBalanceNum))
    setDepositAmount(value) // Allow typing above balance but show error
    if (walletBalanceNum > 0) {
      setSliderValue(Math.min(100, (clamped / walletBalanceNum) * 100))
    }
  }, [walletBalanceNum])

  const handleSliderChange = useCallback((value: number) => {
    setSliderValue(value)
    const amount = (value / 100) * walletBalanceNum
    setDepositAmount(parseFloat(amount.toFixed(6)))
  }, [walletBalanceNum])

  const handleMaxClick = useCallback(() => {
    setDepositAmount(walletBalanceNum)
    setSliderValue(100)
  }, [walletBalanceNum])

  const reset = useCallback(() => {
    setDepositAmount(0)
    setSliderValue(0)
  }, [])

  return {
    // State
    depositAmount,
    lockDays,
    sliderValue,
    walletBalance: walletBalanceNum,

    // Computed
    projectedPoints,
    projectedShare,
    projectedMbrn,
    acquisitionModel,
    existingTotalPoints,
    mostProfitableSlot5,

    // Handlers
    handleAmountChange,
    handleSliderChange,
    handleMaxClick,
    reset,
  }
}
