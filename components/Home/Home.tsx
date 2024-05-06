import { Card, HStack, Input, Stack, Text } from '@chakra-ui/react'
import { StatsCard } from '../StatsCard'
import ConfirmModal from '../ConfirmModal'
import useCollateralAssets from '../Bid/hooks/useCollateralAssets'
import useBalance from '@/hooks/useBalance'
import Select from '@/components/Select'
import useQuickActionState from './hooks/useQuickActionState'
import { SliderWithState } from '../Mint/SliderWithState'
import { useState } from 'react'
import { num } from '@/helpers/num'
import { delayTime } from "@/config/defaults"

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


type SliderWithInputProps = {
  value: number
  setActionState: (set: any) => void
  min: number
  max: number
}

const SliderWithInputBox = ({ setActionState, max }: SliderWithInputProps) => {  
    //inputAmount is separate so we can use both the input box & the slider to set LPState without messing with focus
    const [ inputAmount, setInputAmount ] = useState(0);

    const onSliderChange = (value: number) => {
      setActionState(value)
      setInputAmount(value)    
    }

    const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
      e.preventDefault()
      const newAmount = e.target.value

      if (num(newAmount).isGreaterThan(max)) setInputAmount(max)
        else setInputAmount(parseInt(e.target.value))
      
      setTimeout(() => {
        if (num(newAmount).isGreaterThan(max)) setActionState(max)
          else setActionState(parseInt(e.target.value))
      }, delayTime);        
    }
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
        {/* Asset Menu + Input Box/Slider*/}        
        <Stack py="5" w="full" gap="5">      
          <AssetsWithBalanceMenu />
          <HStack justifyContent="space-between">
            <Text fontSize="16px" fontWeight="700">
              CDT
            </Text>
            <Input 
              width={"38%"} 
              textAlign={"center"} 
              placeholder="0" 
              type="number" 
              value={inputAmount} 
              onChange={handleInputChange}
             />
          </HStack>      
          <SliderWithState
            value={LPState?.newCDT}
            onChange={onCDTChange}
            min={0}
            max={Number(cdtBalance)}
          />
          </Stack>
        </Stack>
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
