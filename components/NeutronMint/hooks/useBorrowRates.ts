import { useMemo } from 'react'
import { useCreditRate } from '@/hooks/useCDP'
import { num } from '@/helpers/num'

interface UseBorrowRatesProps {
  assetSymbol: 'CDT' | 'USDC'
}

export const useBorrowRates = ({ assetSymbol }: UseBorrowRatesProps) => {
  const { data: creditRate } = useCreditRate()

  // Calculate Variable rate from credit_interest
  const variableRate = useMemo(() => {
    if (assetSymbol === 'CDT' && creditRate?.credit_interest) {
      return num(creditRate.credit_interest).times(100).toNumber()
    }
    // For USDC, would need Mars integration
    // For now, return placeholder
    return assetSymbol === 'USDC' ? 7.06 : 4.2
  }, [creditRate, assetSymbol])

  // Calculate fixed rates
  // These are placeholders - actual fixed rates would need backend support
  // Typically fixed rates are higher than variable to compensate for rate lock
  const fixed1mRate = useMemo(() => {
    // Fixed 1-month: variable + 0.5-1% premium
    return num(variableRate).plus(0.8).toNumber()
  }, [variableRate])

  const fixed3mRate = useMemo(() => {
    // Fixed 3-month: variable + 1-1.5% premium
    return num(variableRate).plus(1.2).toNumber()
  }, [variableRate])

  const fixed6mRate = useMemo(() => {
    // Fixed 6-month: variable + 1.5-2% premium
    return num(variableRate).plus(1.8).toNumber()
  }, [variableRate])

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
    getRate,
  }
}





