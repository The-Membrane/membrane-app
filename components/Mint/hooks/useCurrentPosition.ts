import { num } from '@/helpers/num'
import useMintState from './useMintState'
import useVaultSummary from './useVaultSummary'

export const useCurrentPosition = () => {
  const summary = useVaultSummary()
  const { mintState } = useMintState()

  const isValueChanged = !num(mintState.totalUsdValue).isZero()

  return [
    {
      label: 'DEBT',
      value: `${summary.debtAmount?.toFixed(0)} CDT`,
    },
    {
      label: 'LTV',
      value: `${summary.ltv}%`,
      textColor: isValueChanged ? 'primary.200' : 'white',
    },
    {
      label: 'COST',
      value: `${summary.cost?.toFixed(4)}%`,
    },
    {
      label: 'LIQ. VALUE',
      value: `$${summary.liquidValue?.toFixed(2)}`,
    },
    {
      label: 'BORROWABLE LTV',
      value: `${summary?.borrowLTV}%`,
      textColor: isValueChanged ? 'primary.200' : 'white',
    },
    {
      label: 'LIQUIDATION LTV',
      value: `${summary.liqudationLTV?.toFixed(2)}%`,
      textColor: isValueChanged ? 'primary.200' : 'white',
    },
    {
      label: 'TVL',
      value: `$${summary?.tvl?.toFixed(2)}`,
      textColor: isValueChanged ? 'primary.200' : 'white',
    },
  ]
}
