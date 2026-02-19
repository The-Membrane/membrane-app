import { useMemo } from 'react'
import { useCreditRate, useRates } from '@/hooks/useCDP'
import useAppState from '@/persisted-state/useAppState'
import { num } from '@/helpers/num'

interface UseBorrowRatesProps {
  assetSymbol: 'CDT' | 'USDC'
}

export const useBorrowRates = ({ assetSymbol }: UseBorrowRatesProps) => {
  const { appState } = useAppState()
  const { data: creditRate } = useCreditRate()
  const { data: rates } = useRates(appState.rpcUrl)

  // Calculate Variable rate
  const variableRate = useMemo(() => {
    if (assetSymbol === 'CDT' && creditRate?.credit_interest) {
      return num(creditRate.credit_interest).times(100).toNumber()
    }
    // For USDC, use peg_rate_at_target from the Rates query
    if (assetSymbol === 'USDC' && rates?.peg_rate_at_target?.length) {
      // Average across collateral types for display
      const sum = rates.peg_rate_at_target.reduce(
        (acc: number, r: string) => acc + num(r).times(100).toNumber(),
        0
      )
      return sum / rates.peg_rate_at_target.length
    }
    return 0
  }, [creditRate, rates, assetSymbol])

  // Get fixed rate multipliers from the Rates query
  const fixedMultipliers = useMemo(() => {
    if (!rates?.fixed_rate_caps) {
      return { oneMonth: 1.2, threeMonth: 1.5, sixMonth: 2.0 }
    }
    return {
      oneMonth: num(rates.fixed_rate_caps.one_month.multiplier).toNumber() || 1.2,
      threeMonth: num(rates.fixed_rate_caps.three_month.multiplier).toNumber() || 1.5,
      sixMonth: num(rates.fixed_rate_caps.six_month.multiplier).toNumber() || 2.0,
    }
  }, [rates])

  // Fixed rate = collateral weighted rate * multiplier
  // For the table/modal overview, we use the variable rate as the base
  // The actual per-position fixed rate depends on collateral composition
  const fixed1mRate = useMemo(() => {
    return num(variableRate).times(fixedMultipliers.oneMonth).toNumber()
  }, [variableRate, fixedMultipliers])

  const fixed3mRate = useMemo(() => {
    return num(variableRate).times(fixedMultipliers.threeMonth).toNumber()
  }, [variableRate, fixedMultipliers])

  const fixed6mRate = useMemo(() => {
    return num(variableRate).times(fixedMultipliers.sixMonth).toNumber()
  }, [variableRate, fixedMultipliers])

  // Get rate for a specific rate type
  const getRate = (rateType: 'variable' | 'fixed-1m' | 'fixed-3m' | 'fixed-6m') => {
    switch (rateType) {
      case 'variable':
        return variableRate
      case 'fixed-1m':
        return fixed1mRate
      case 'fixed-3m':
        return fixed3mRate
      case 'fixed-6m':
        return fixed6mRate
      default:
        return variableRate
    }
  }

  return {
    variable: variableRate,
    fixed1m: fixed1mRate,
    fixed3m: fixed3mRate,
    fixed6m: fixed6mRate,
    fixedMultipliers,
    getRate,
  }
}
