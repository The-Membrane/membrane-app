import { Card, Stack, Text } from '@chakra-ui/react'
import { StatsCard } from '../StatsCard'
import ConfirmModal from '../ConfirmModal'
import useCollateralAssets from '../Bid/hooks/useCollateralAssets'
import useBalance from '@/hooks/useBalance'
import Select from '@/components/Select'
import useQuickActionState from './hooks/useQuickActionState'

type Props = {}

const AssetsWithBalanceMenu = (props: Props) => {
  const assets = useCollateralAssets()
  const { data: walletBalances } = useBalance()
  
  const assetsWithBalance = [];
  assets?.forEach((asset) => {
    const balance = walletBalances?.find((b: any) => b.denom === asset?.base)?.amount
    
    if (balance && parseInt(balance) > 0) assetsWithBalance.push({...asset, balance})
  })

  const { quickActionState, setQuickActionState } = useQuickActionState()
  
  const onChange = (value: string) => {
    setQuickActionState({
      selectedAsset: value
    })
  }

  return <Select options={assetsWithBalance} onChange={onChange} value={quickActionState?.selectedAsset??"No Collateral Assets in Wallet"} />
}


const Home = () => {
  return (
    <Stack >
      <StatsCard />      
      <Card w="256px" alignItems="center" justifyContent="space-between" p="8" gap="0">
        <Text variant="title" fontSize="16px">
          Single Asset Mint & LP
        </Text>

        {/* //Action */}
        {/* Asset Menu + Input Box*/}
        {/* LTV Input Box */}

        <ConfirmModal label={'LP'}>
          Deposit - Mint - LP Summary
        </ConfirmModal>
      </Card>
      {/* <Text variant="title" letterSpacing="unset" textShadow="0px 0px 8px rgba(223, 140, 252, 0.80)">
        More Stats Coming Soon...
      </Text> */}
    </Stack>
  )
}

export default Home
