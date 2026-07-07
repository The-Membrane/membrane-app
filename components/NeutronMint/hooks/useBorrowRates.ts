import { useMemo } from 'react'
import { useRates } from '@/hooks/useCDP'
import useAppState from '@/persisted-state/useAppState'
import { num } from '@/helpers/num'

interface UseBorrowRatesProps {
  assetSymbol: 'CDT' | 'USDC'
}

/**
 * Borrow-rate display — EVM migration.
 *
 * TODO(evm-migration): there is no ported credit-interest / peg-rate view (getCreditRate is a
 * documented stub in services/chain/cdp.ts). useRates now returns EvmRatesConfig (from
 * cdp.ratesConfig), so the closest real read for the CDT variable rate is the global
 * baseInterestRate (1e18-fractional); per-asset adaptive composition is not reproduced here,
 * and the USDC peg rate has no EVM equivalent (→ 0). Fixed-tranche multipliers live in
 * Cdp.sol fixedRateCaps(), which is not surfaced through EvmRatesConfig — the prior display
 * fallbacks (1.2 / 1.5 / 2.0) are retained.
 */
export const useBorrowRates = ({ assetSymbol }: UseBorrowRatesProps) => {
  const { appState } = useAppState()
  const { data: rates } = useRates(appState.rpcUrl)

  // Variable rate from the global base interest rate (1e18-fractional) for CDT; USDC → 0.
  const variableRate = useMemo(() => {
    if (assetSymbol === 'CDT' && rates?.baseInterestRate != null) {
      return num(rates.baseInterestRate.toString()).dividedBy(1e18).times(100).toNumber()
    }
    return 0
  }, [rates, assetSymbol])

  // Fixed-rate multipliers — display fallbacks (fixedRateCaps() not surfaced via EvmRatesConfig).
  const fixedMultipliers = useMemo(
    () => ({ oneMonth: 1.2, threeMonth: 1.5, sixMonth: 2.0 }),
    [],
  )

  const fixed1mRate = useMemo(() => {
    return num(variableRate).times(fixedMultipliers.oneMonth).toNumber()
  }, [variableRate, fixedMultipliers])

  const fixed3mRate = useMemo(() => {
    return num(variableRate).times(fixedMultipliers.threeMonth).toNumber()
  }, [variableRate, fixedMultipliers])

  const fixed6mRate = useMemo(() => {
    return num(variableRate).times(fixedMultipliers.sixMonth).toNumber()
  }, [variableRate, fixedMultipliers])

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
