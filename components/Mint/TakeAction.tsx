import { setInitialMintState } from '@/helpers/mint'
import { num } from '@/helpers/num'
import { Divider, TabPanel, Text } from '@chakra-ui/react'
import { useEffect } from 'react'
import ActionButtons from './ActionButtons'
import CollateralAssets from './CollateralAssets'
import { LTVWithSlider } from './LTVWithSlider'
import useCombinBalance from './hooks/useCombinBalance'
import useMintState from './hooks/useMintState'
import useVaultSummary from './hooks/useVaultSummary'
import React from 'react'

const OverDraftMessage = ({ overdraft = false, minDebt = false}: { overdraft?: boolean, minDebt?: boolean }) => {
  return (
    <Text fontSize="sm" color="red.500" mt="2" minH="21px">
      {overdraft ? 'Withdrawal amount exceeds the maximum LTV.' : minDebt ? 'Minimum debt is 100 CDT unless fully repaying' : ' '}
    </Text>
  )
}

export const calcSliderValue = (debtAmount: number, mint: number = 0, repay: number = 0) => {
  console.log("calc slider value", debtAmount, mint, repay)
  return num(debtAmount).plus(mint).minus(repay).dp(2).toNumber()
}

const TakeAction = React.memo(() => {
  const { mintState, setMintState } = useMintState()
  const combinBalance = useCombinBalance(mintState.positionNumber-1)
  const { data } = useVaultSummary()
  const { ltv, borrowLTV, initialBorrowLTV, initialLTV, debtAmount } = data || {
    debtAmount: 0,
    cost: 0,
    tvl: 0,
    ltv: 0,
    borrowLTV: 0,
    liquidValue: 0,
    liqudationLTV: 0,
  }

  useEffect(() => {
    const overdraft = ltv > borrowLTV
    setMintState({ overdraft })
  }, [ltv, borrowLTV])

  const onRest = () => {
    setInitialMintState({
      combinBalance,
      ltv: initialLTV,
      borrowLTV: initialBorrowLTV,
      setMintState,
      //newDebtAmount: 0,
    })
  }

  return (
    <TabPanel>
      <CollateralAssets />

      <Divider
        bg="rgba(226, 216, 218, 0.24)"
        boxShadow="0px 0px 8px 0px rgba(226, 216, 218, 0.64)"
        w="calc(100% - 16px)"
        h="1px"
        my="5"
        mx="3"
      />

      <LTVWithSlider label="Your Debt" />
      <ActionButtons onRest={onRest} />
      <OverDraftMessage overdraft={mintState.overdraft} minDebt={mintState.belowMinDebt}/>
    </TabPanel>
  )
})

export default TakeAction
