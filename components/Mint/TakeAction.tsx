import { setInitialMintState } from '@/helpers/mint'
import { num } from '@/helpers/num'
import { Button, Divider, HStack, Stack, TabIndicator, TabList, TabPanel, Tabs, Text } from '@chakra-ui/react'
import { useEffect, useState } from 'react'
import ActionButtons from './ActionButtons'
import CollateralAssets from './CollateralAssets'
import { LTVWithSlider } from './LTVWithSlider'
import useCombinBalance from './hooks/useCombinBalance'
import useMintState from './hooks/useMintState'
import useVaultSummary from './hooks/useVaultSummary'
import React from 'react'
import { colors } from '@/config/defaults'
import { MintInput } from './MintInput'
import { GrPowerReset } from 'react-icons/gr'
import { CustomTab } from './AssetWithInput'
// import { queryClient } from '@/pages/_app'
// import useBasketState from '@/persisted-state/useBasketState'

const OverDraftMessage = ({ overdraft = false, minDebt = false, ltvChange = false }: { overdraft?: boolean, minDebt?: boolean, ltvChange?: boolean }) => {
  return (
    <Text fontSize="sm" color={"white"} mt="2" mb={"0"} minH="21px" alignSelf="center" w="100%" textAlign="center">
      {(overdraft && ltvChange) ? '⚠️ Collateral update reduces the weighted LTV and causes the debt to exceed the max LTV.' : (overdraft && !ltvChange) ? '⚠️ Withdrawal amount exceeds the maximum LTV.' : minDebt ? '⚠️ Minimum debt is 20 CDT unless fully repaying.' : ' '}
    </Text>

  )
}

const TakeAction = React.memo(() => {
  const { mintState, setMintState } = useMintState()
  const combinBalance = useCombinBalance(mintState.positionNumber - 1)

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


  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const handleTabClick = (index: string) => {
    setActiveTabIndex(index === "deposit" ? 0 : 1);
    setMintState({ transactionType: index });
    setInitialMintState({
      combinBalance,
      ltv: initialLTV,
      borrowLTV: initialBorrowLTV,
      setMintState,
      reset: mintState.reset
    });
  };

  return (
    <Stack width="100%" flex="1" >

      <Tabs position="relative" variant="unstyled" align="center" w="full" index={activeTabIndex}>
        <TabList bg="white" borderRadius="28px" color="black" w="fit-content">
          <CustomTab onClick={() => handleTabClick("deposit")} label="Deposit" />
          <CustomTab onClick={() => handleTabClick("withdraw")} label="Withdraw" />
        </TabList>

        <TabIndicator
          top="0"
          position="absolute"
          height="45px"
          bg={colors.walletIcon}
          borderRadius="28px"
        />
      </Tabs>
      <CollateralAssets />

      {/* <Stack marginTop={"auto"}> */}
      <Divider
        bg="rgba(226, 216, 218, 0.24)"
        boxShadow="0px 0px 8px 0px rgba(226, 216, 218, 0.64)"
        w="calc(100% - 16px)"
        h="1px"
        my="5"
        mx="3"
      />


      <MintInput label="Borrow CDT" />
      {/* <LTVWithSlider label="Your Debt" /> */}
      <ActionButtons />
      <OverDraftMessage overdraft={mintState.overdraft} minDebt={mintState.belowMinDebt} ltvChange={initialBorrowLTV != borrowLTV && ltv === initialLTV} />
      {/* </Stack> */}
    </Stack>
  )
})

export default TakeAction
