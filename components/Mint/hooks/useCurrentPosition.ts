import { num } from '@/helpers/num'
import useMintState from './useMintState'
import useVaultSummary from './useVaultSummary'
import { useEffect, useState } from 'react'

    //@ts-ignore
const getDebtAmount = (summary) => {
  const { debtAmount, newDebtAmount } = summary

  if (num(newDebtAmount).isGreaterThan(0)) {
    return newDebtAmount
  }

  return debtAmount
}

export const useCurrentPosition = () => {
  const { data } = useVaultSummary()
  const [summary, setSummary] = useState({
    newDebtAmount: 0,
    debtAmount: 0,
    cost: 0,
    discountedCost: 0,
    tvl: 0,
    ltv: 0,
    borrowLTV: 0,
    liquidValue: 0,
    liqudationLTV: 0,
  });

  useEffect(() => {
    if (data) {
      setSummary({...data}); // Only update if data is available
    }
  }, [data]); // Runs when `data` changes
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
      value: `$${summary?.liquidValue?.toFixed(2)}`,
    },
    {
      label: 'DEBT',
      value: `${getDebtAmount(summary)} CDT`,
      textColor: isValueChanged ? 'primary.200' : 'white',
    },
    {
      label: 'DYNAMIC COST',
      value: `${num(summary?.discountedCost).multipliedBy(100).toFixed(2)}% / year`,
      textColor: summary?.cost != summary?.discountedCost ? 'primary.200' : 'white'
    },
    {
      label: 'BORROWABLE LTV',
      value: `${summary?.borrowLTV.toFixed(0)}%`,
      textColor: summary?.newDebtAmount ? 'primary.200' : 'white',
    },
    {
      label: 'LTV',
      value: `${summary?.ltv.toFixed(0)}%`,
      textColor: isValueChanged ? 'primary.200' : 'white',
    },
    {
      label: 'LIQUIDATION LTV',
      value: `${summary?.liqudationLTV?.toFixed(0)}%`,
      textColor: isValueChanged ? 'primary.200' : 'white',
    },
  ]
}
