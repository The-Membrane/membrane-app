import TxError from '@/components/TxError'
import { setInitialMintState } from '@/helpers/mint'
import { num } from '@/helpers/num'
import { Divider, TabPanel, Text } from '@chakra-ui/react'
import { useEffect } from 'react'
import ActionButtons from './ActionButtons'
import CollateralAssets from './CollateralAssets'
import { LTVWithSlider } from './LTVWithSlider'
import useCombinBalance from './hooks/useCombinBalance'
import useMint from './hooks/useMint'
import useMintState from './hooks/useMintState'
import useVaultSummary from './hooks/useVaultSummary'

const OverDraftMessage = ({ show = false }: { show?: boolean }) => {
  return (
    <Text fontSize="sm" color="red.500" mt="2" minH="21px">
      {show ? 'Withdrawal amount exceeds the maximum LTV.' : ' '}
    </Text>
  )
}

const calcSliderValue = (debtAmount: number, mint: number = 0, repay: number = 0) => {
  return num(debtAmount).plus(mint).minus(repay).dp(2).toNumber()
}

const TakeAction = () => {
  const { mintState, setMintState } = useMintState()
  const combinBalance = useCombinBalance()
  const mint = useMint()
  const { ltv, borrowLTV, initialBorrowLTV, initialLTV, debtAmount } = useVaultSummary()

  useEffect(() => {
    const overdraft = ltv > borrowLTV
    setMintState({ overdraft })
  }, [ltv, borrowLTV])

  const sliderValue = calcSliderValue(debtAmount, mintState.mint, mintState.repay)

  const onRest = () => {
    setInitialMintState({
      combinBalance,
      ltv: initialLTV,
      borrowLTV: initialBorrowLTV,
      setMintState,
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

      <LTVWithSlider label="Mintable LTV" value={sliderValue} />
      <ActionButtons onRest={onRest} />
      <OverDraftMessage show={mintState.overdraft} />
      <TxError action={mint} />
    </TabPanel>
  )
}

export default TakeAction
