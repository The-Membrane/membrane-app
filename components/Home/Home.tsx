import { Card, HStack, Input, Stack, Text } from '@chakra-ui/react'
import { StatsCard } from '../StatsCard'
import ConfirmModal from '../ConfirmModal'
import useCollateralAssets from '../Bid/hooks/useCollateralAssets'
import useBalance, { useBalanceByAsset } from '@/hooks/useBalance'
import QASelect from '@/components/QuickActionSelect'
import useQuickActionState, { QuickActionState } from './hooks/useQuickActionState'
import { SliderWithState } from '../Mint/SliderWithState'
import { ChangeEvent, useEffect, useMemo, useState } from 'react'
import { num, shiftDigits } from '@/helpers/num'
import { delayTime } from "@/config/defaults"
import { Asset } from '@/helpers/chain'
import { Coin } from '@cosmjs/stargate'
import { LTVWithSlider } from '../Mint/LTVWithSlider'
import useVaultSummary from '../Mint/hooks/useVaultSummary'
import useMintState from '../Mint/hooks/useMintState'
import { calcSliderValue } from '../Mint/TakeAction'
import { AssetWithSlider } from '../Mint/AssetWithSlider'
import { useOraclePrice } from '@/hooks/useOracle'

type Props = {
  value: string
  onChange: (value: string) => void
  walletBalances: Coin[]
  QAState: QuickActionState
  setQAState: (set: any) => void
}

const AssetsWithBalanceMenu = ({ value, onChange, walletBalances, QAState, setQAState }: Props) => {
  const assets = useCollateralAssets()
  const { data: prices } = useOraclePrice()
  
  //List of all denoms in the wallet
  const walletDenoms = walletBalances.map((coin: Coin) => {
    if (num(coin.amount).isGreaterThan(0)) return coin.denom
    else return ""
  }).filter((asset: string) => asset != "");


  //Create an object of assets that only holds assets that have a walletBalance
  const assetsWithBalance = useMemo(() => {
      // const balance = walletBalances?.find((b: any) => b.denom === (assets?.[0]?.base) )?.amount??"0"
      // const price = prices?.find((p: any) => p.denom === (assets?.[0]?.base) )?.price??"0"

      return assets?.filter((asset) => {
        if (asset) return walletDenoms.includes(asset.base)
        else return false
      }).map((asset) => ({
        ...asset,
        value: asset?.symbol,
        label: asset?.symbol,
        balance: Number(walletBalances?.find((b: any) => b.denom === asset.base)?.amount),
        combinUsdValue: num(walletBalances?.find((b: any) => b.denom === asset.base)?.amount).times(num(prices?.find((p: any) => p.denom === asset.base)??"0")).toNumber()
      }))

  }, [assets, walletBalances, prices])

  useEffect(() => {
    if (!QAState?.selectedAsset && assetsWithBalance?.[0]) {
      const balance = walletBalances.find((b: any) => b.denom === (assetsWithBalance?.[0] as Asset).base)?.amount??"0"

      setQAState({
        selectedAsset: assetsWithBalance?.[0],
        assetMax: parseInt(balance??"0")        
      })
    }
  }, [assetsWithBalance, walletBalances])

  return <QASelect options={assetsWithBalance} onChange={onChange} value={value} />
}


type SliderWithInputProps = {
  value: number
  setActionState: (set: any) => void
  max: number
  inputBoxWidth?: string
  QAState: QuickActionState
  setQAState: (set: any) => void
  onMenuChange: (value: string) => void
  walletBalances: Coin[]
}

const SliderWithInputBox = ({ value, setActionState, max, inputBoxWidth = "38%", QAState, setQAState, onMenuChange, walletBalances }: SliderWithInputProps) => {  
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

    return (
    <Stack py="5" w="full" gap="5">     
      <Text fontSize="14px" fontWeight="700">
        Choose Collateral
      </Text> 
      <HStack justifyContent="space-between">
        <AssetsWithBalanceMenu 
          value={QAState?.selectedAsset} 
          onChange={onMenuChange}
          walletBalances={walletBalances??[]}
          QAState={QAState}
          setQAState={setQAState}
        />
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

  useEffect(() => {
    if (quickActionState?.selectedAsset) {
      const balance = walletBalances?.find((b: any) => b.denom === quickActionState?.selectedAsset?.base)?.amount

      setQuickActionState({assetMax: parseInt(balance??"0")})
    }
  
  }, [quickActionState.selectedAsset])

  //Use mintState to update the deposit state
  const { mintState } = useMintState()
  //When QA's assetActionAmount changes, update the deposit state
  useEffect(() => {

  }, [quickActionState.assetActionAmount])

  
  const { debtAmount } = useVaultSummary()
  const sliderValue = calcSliderValue(debtAmount, mintState.mint, mintState.repay)

  return (
    <Stack >
      <StatsCard />      
      <Card w="384px" alignItems="center" justifyContent="space-between" p="8" gap="0">
        <Text variant="title" fontSize="16px">
          Mint & LP
        </Text>

        {/* //Action */}
        {/* Asset Menu + Input Box/Slider*/}        
        <Stack py="5" w="full" gap="2">
          <SliderWithInputBox
            value={quickActionState.assetActionAmount}
            setActionState={(value: number) => setQuickActionState({ assetActionAmount: value })}
            max={num(shiftDigits(quickActionState.assetMax, -(quickActionState?.selectedAsset?.decimal??6))).toNumber()}
            inputBoxWidth='42%'
            QAState={quickActionState}
            setQAState={setQuickActionState}
            onMenuChange={onMenuChange}
            walletBalances={walletBalances??[]}
          />
          <AssetWithSlider key={quickActionState?.selectedAsset?.base} asset={quickActionState?.selectedAsset} label={quickActionState?.selectedAsset?.symbol} />
          <LTVWithSlider label="Your Debt" value={sliderValue}/>
        </Stack>
        {/* LTV Input Box */}

        <ConfirmModal label={'LP'}>
          Deposit - Mint - LP Summary
        </ConfirmModal>
      </Card>
    </Stack>
  )
}

export default Home
