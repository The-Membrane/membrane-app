import { Card, HStack, Input, Stack, Text } from '@chakra-ui/react'
import { StatsCard } from '../StatsCard'
import ConfirmModal from '../ConfirmModal'
import useCollateralAssets from '../Bid/hooks/useCollateralAssets'
import useBalance, { useBalanceByAsset } from '@/hooks/useBalance'
import QASelect from '@/components/QuickActionSelect'
import useQuickActionState, { QuickActionState } from './hooks/useQuickActionState'
import { SliderWithState } from '../Mint/SliderWithState'
import { ChangeEvent, useEffect, useMemo, useState } from 'react'
import { num } from '@/helpers/num'
import { delayTime } from "@/config/defaults"
import { Asset } from '@/helpers/chain'

type Props = {
  value: any
  onChange: (value: string) => void
  walletBalances: any
  QAState: QuickActionState
  setQAState: (set: any) => void
}

const AssetsWithBalanceMenu = ({ value, onChange, walletBalances, QAState, setQAState }: Props) => {
  const assets = useCollateralAssets()
  
  // const assetsWithBalance: any[] = [];
  // useMemo( () => {assets?.forEach((asset) => {
  //   const balance = walletBalances?.find((b: any) => b.denom === asset?.base)?.amount
    
  //   if (balance && parseInt(balance) > 0) assetsWithBalance.push({...asset, balance: parseInt(balance)})
  // })}, [walletBalances])

  console.log(walletBalances)
  console.log(assets?.filter((asset) => {
    walletBalances?.find((b: any) => b.denom === asset?.base)?.amount != "0"
  }))

  const assetsWithBalance = assets
    ?.map((asset) => ({
      ...asset,
      value: asset?.symbol,
      label: asset?.symbol,
    }))

  useEffect(() => {
    if (!QAState?.selectedAsset && assetsWithBalance?.[0]) {
      setQAState({
        selectedAsset: assetsWithBalance?.[0],
      })
    }
  }, [assetsWithBalance])

  console.log("Options:", assetsWithBalance)
  console.log("Value:", value)

  return <QASelect options={assetsWithBalance} onChange={onChange} value={value} />
}


type SliderWithInputProps = {
  label: string
  value: number
  setActionState: (set: any) => void
  max: number
  inputBoxWidth?: string
}

export const SliderWithInputBox = ({ label, value, setActionState, max, inputBoxWidth = "38%" }: SliderWithInputProps) => {  
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

    return (<Stack py="5" w="full" gap="5">      
    <HStack justifyContent="space-between">
      <Text fontSize="16px" fontWeight="700">
        {label}
      </Text>
      <Input 
        width={inputBoxWidth} 
        textAlign={"center"} 
        placeholder="0" 
        type="number" 
        value={inputAmount} 
        onChange={handleInputChange}
      />
    </HStack>      
    <SliderWithState
      value={value}
      onChange={onSliderChange}
      min={0}
      max={max}
    />
  </Stack>)
}


const Home = () => { 
  const { data: walletBalances } = useBalance()
  const { quickActionState, setQuickActionState } = useQuickActionState()
  
  const onMenuChange = (value: string) => {
    setQuickActionState({
      selectedAsset: value
    })
  }

  return (
    <Stack >
      <StatsCard />      
      <Card w="256px" alignItems="center" justifyContent="space-between" p="8" gap="0">
        <Text variant="title" fontSize="16px">
          Mint & LP
        </Text>

        {/* //Action */}
        {/* Asset Menu + Input Box/Slider*/}        
        <Stack py="5" w="full" gap="5">      
          <AssetsWithBalanceMenu 
            value={quickActionState?.selectedAsset}
            onChange={onMenuChange}
            walletBalances={walletBalances}
          />
          <SliderWithInputBox
            label={quickActionState?.selectedAsset?.symbol} 
            value={quickActionState.assetActionAmount}
            setActionState={(value: number) => setQuickActionState({ assetActionAmount: value })}
            max={0}
          />
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
