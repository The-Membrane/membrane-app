import { num } from '@/helpers/num'
import useMintState from './useMintState'
import useVaultSummary from './useVaultSummary'

export const useCurrentPosition = () => {
  const summary = useVaultSummary()
  const { mintState } = useMintState()

  const isValueChanged = !num(mintState.totalUsdValue).isZero()

  return [
    {
      label: 'YOUR COLLATERAL VALUE',
      value: `$${summary?.tvl?.toFixed(2)}`,
      textColor: isValueChanged ? 'primary.200' : 'white',
    },
    {
      label: 'LIQUIDATION VALUE',
      value: `$${summary.liquidValue?.toFixed(2)}`,
    },
    {
      label: 'DEBT',
      value: `${summary.debtAmount?.toFixed(0)} CDT`,
    },
    {
      label: 'COST',
      value: `${summary.cost?.toFixed(4)}% / year`,
    },
    {
      label: 'BORROWABLE LTV',
      value: `${summary?.borrowLTV.toFixed(0)}%`,
      textColor: isValueChanged ? 'primary.200' : 'white',
    },
    {
      label: 'LTV',
      value: `${summary.ltv.toFixed(0)}%`,
      textColor: isValueChanged ? 'primary.200' : 'white',
    },
    {
      label: 'LIQUIDATION LTV',
      value: `${summary.liqudationLTV?.toFixed(0)}%`,
      textColor: isValueChanged ? 'primary.200' : 'white',
    },
  ]
}
