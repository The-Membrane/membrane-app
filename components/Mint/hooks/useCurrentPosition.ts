import { num } from '@/helpers/num'
import useMintState from './useMintState'
import useVaultSummary from './useVaultSummary'
import { useEffect, useMemo, useState } from 'react'
import { colors } from '@/config/defaults'

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

  const health = useMemo(() => {
    if (summary.ltv === 0) return 100
    return num(1).minus(num(summary.ltv).dividedBy(summary.liqudationLTV)).times(100).dp(0).toNumber()
  }, [summary.ltv, summary.liqudationLTV])

  useEffect(() => {
    if (data) {
      setSummary({ ...data }); // Only update if data is available
    }
  }, [data]); // Runs when `data` changes
  const { mintState } = useMintState()
  const isValueChanged = !num(mintState.totalUsdValue).isZero()

  return {
    health, stats: [
      {
        label: 'COLLATERAL VALUE',
        value: `$${summary?.tvl?.toFixed(2)}`,
        textColor: isValueChanged ? colors.tabBG : 'white',
      },
      {
        label: 'LIQUIDATION VALUE',
        value: `$${summary?.liquidValue?.toFixed(2)}`,
      },
      {
        label: 'DEBT',
        value: `${getDebtAmount(summary)} CDT`,
        textColor: isValueChanged ? colors.tabBG : 'white',
      },
      {
        label: 'DYNAMIC COST',
        value: `${num(summary?.discountedCost).multipliedBy(100).toFixed(2)}% / year`,
        textColor: summary?.cost != summary?.discountedCost ? colors.tabBG : 'white'
      },
      {
        label: 'BORROWABLE LTV',
        value: `${summary?.borrowLTV.toFixed(0)}%`,
        textColor: summary?.newDebtAmount ? colors.tabBG : 'white',
      },
      {
        label: 'LTV',
        value: `${summary?.ltv.toFixed(0)}%`,
        textColor: isValueChanged ? colors.tabBG : 'white',
      },
      {
        label: 'LIQUIDATION LTV',
        value: `${summary?.liqudationLTV?.toFixed(0)}%`,
        textColor: isValueChanged ? colors.tabBG : 'white',
      },
    ]
  }
}
