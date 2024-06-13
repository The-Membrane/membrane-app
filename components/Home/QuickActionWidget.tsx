import { Card, HStack, Stack, Text, Checkbox } from '@chakra-ui/react'
import ConfirmModal from '../ConfirmModal'
import useCollateralAssets from '../Bid/hooks/useCollateralAssets'
import useBalance from '@/hooks/useBalance'
import useQuickActionState from './hooks/useQuickActionState'
import { useEffect, useMemo, useState } from 'react'
import { isGreaterThanZero, num, shiftDigits } from '@/helpers/num'
import { Coin } from '@cosmjs/stargate'
import { useOraclePrice } from '@/hooks/useOracle'
import useQuickAction from './hooks/useQuickAction'
import { QASummary } from './QASummary'
import useWallet from '@/hooks/useWallet'
import { ConnectButton } from '../WallectConnect'
import { SliderWithInputBox } from './QuickActionSliderInput'
import Divider from '../Divider'
import { SWAP_SLIPPAGE } from '@/config/defaults'

const QuickActionWidget = () => {

  const { quickActionState, setQuickActionState } = useQuickActionState()

  const { isWalletConnected, address } = useWallet("osmosis")

  const { data: walletBalances } = useBalance("osmosis")
  const assets = useCollateralAssets()
  const { data: prices } = useOraclePrice()
  const { action: quickAction, newPositionLTV, newPositionValue} = useQuickAction()
  
  const [ inputAmount, setInputAmount ] = useState(0);
  
  ////Get all assets that have a wallet balance///////
  //List of all denoms in the wallet
  const walletDenoms = (walletBalances??[]).map((coin: Coin) => {
    if (num(coin.amount).isGreaterThan(0)) return coin.denom
    else return ""
  }).filter((asset: string) => asset != "");

  //Create an object of assets that only holds assets that have a walletBalance
  useMemo(() => {    
    if (prices && walletBalances && assets){
        const assetsWithBalance = assets?.filter((asset) => {
          if (asset !== undefined) return walletDenoms.includes(asset.base)
          else return false
        }).map((asset) => {
          if (!asset) return
          
          return {
            ...asset,
            value: asset?.symbol,
            label: asset?.symbol,
            sliderValue: 0,
            balance: num(shiftDigits((walletBalances?.find((b: any) => b.denom === asset.base)?.amount??0), -(asset?.decimal??6))).toNumber(),
            price: Number(prices?.find((p: any) => p.denom === asset.base)?.price??"0"),
            combinUsdValue: num(num(shiftDigits((walletBalances?.find((b: any) => b.denom === asset.base)?.amount??0), -(asset?.decimal??6))).times(num(prices?.find((p: any) => p.denom === asset.base)?.price??"0"))).toNumber()
          }
        }).filter((asset) => {
          if (!asset) return false
           //This helps us decrease the menu size by removing dust
           //Technically we could do anything under $110 as that's the minimum but for new users that adds confusion
          if (asset.combinUsdValue < 5) return false
          else return true
        })

        //Sort assets by USD value
        assetsWithBalance.sort((a, b) => {
          if (a.combinUsdValue < b.combinUsdValue) return 1
          else return -1
        })

        setQuickActionState({
          assets: (assetsWithBalance??[])
        })
      }
  }, [assets, walletBalances, prices, address])

  useEffect(() => {
    if (!quickActionState?.levAsset && (quickActionState?.assets??[]).length > 0) {
      setQuickActionState({
        levAsset:  quickActionState?.assets[0], 
      })
    }
  }, [quickActionState?.assets, walletBalances])

  //Split assets w/ balance into leveraged and stable assets
  const { levAssets, stableAssets } = useMemo(() => {

    const levAssets = (quickActionState?.assets??[]).filter((asset) => {
      if (asset === undefined) return false
      if (asset.symbol === "USDC" || asset.symbol === "USDT" || asset.symbol === "USDC.axl") return false
      else return true
    })

    const stableAssets = (quickActionState?.assets??[]).filter((asset) => {
      if (asset === undefined) return false
      if (asset.symbol === "USDC" || asset.symbol === "USDT") return true
      else return false
    })

    return { levAssets, stableAssets }

  }, [quickActionState?.assets])
  //
  
  const onLevAssetMenuChange = (value: string) => {
    setQuickActionState({
      levAsset: value
    })
  }
  const onStableAssetMenuChange = (value: string) => {
    setQuickActionState({
      levAsset: value
    })
  }

  useEffect(() => {
    if (quickActionState?.assets && quickActionState?.levAsset?.symbol != undefined) {
      setQuickActionState({
        levAsset: quickActionState?.assets.find((asset) => asset.symbol === quickActionState?.levAsset?.symbol),
      })
    }
    
  }, [quickActionState?.assets, quickActionState?.levAsset?.symbol])

  console.log(quickAction?.simulate.errorMessage, quickAction?.simulate.isError, !quickAction?.simulate.data)

  ///////Basic Onboarding Card///////
  return (
    <HStack justifyContent="center">
    <Card w="384px" alignItems="center" justifyContent="space-between" p="8" gap="0">
        {!isWalletConnected ? 
        <ConnectButton marginTop={6}/>
        : quickActionState.assets.length === 0 ? 
        <Text variant="body" fontSize="16px" marginTop={6}>
            Loading your available collateral assets...
        </Text>
        : 
        <>
        {/* //Action */}
        {/* Asset Menu + Input Box/Sliders*/}        
        <Stack py="5" w="full" gap="2" mb="0">
        <Text fontSize="14px" fontWeight="700">
          Choose Collateral to Leverage
        </Text> 
        <Divider mx="0" mt="0" mb="5"/>
        <SliderWithInputBox
            max={quickActionState?.levAsset?.combinUsdValue??0}
            inputBoxWidth='42%'
            assets={levAssets}
            QAState={quickActionState}
            setQAState={setQuickActionState}
            onMenuChange={onLevAssetMenuChange}
            inputAmount={inputAmount}
            setInputAmount={setInputAmount}
        />
        {quickActionState.levAsset?.amount !== 0 && stableAssets.length !== 0 ? <><Text fontSize="14px" fontWeight="700">
          Add Stables to Increase Leverage up to 900%
        </Text> 
        <Divider mx="0" mt="0" mb="5"/>
        <SliderWithInputBox
            max={quickActionState?.stableAsset?.combinUsdValue??0}
            inputBoxWidth='42%'
            assets={stableAssets}
            QAState={quickActionState}
            setQAState={setQuickActionState}
            onMenuChange={onStableAssetMenuChange}
            inputAmount={inputAmount}
            setInputAmount={setInputAmount}
            stable={true}
        /></> : null}
         {(quickActionState.levAsset?.sliderValue??0 + (quickActionState.stableAsset?.sliderValue??0)) < 222 ? <Text fontSize="sm" color="red.500" mt="2" minH="21px">
            Minimum to leverage: $222. Please add more collateral.
          </Text>
          : levAssets.length === 0 ?
          <Text fontSize="sm" color="red.500" mt="2" minH="21px">
            No available collateral assets in your wallet. 
            {/* Add Onboarding Button here */}
          </Text>
          : null }
        <Text fontSize="sm" color="white" mt="2" minH="21px">
            max slippage: {SWAP_SLIPPAGE}%
        </Text>
        </Stack>

        {/* Leverage Button */}
        <ConfirmModal 
        action={quickAction}
        label={"Begin Degeneracy"}
        isDisabled={quickAction?.simulate.isError || !quickAction?.simulate.data}>
          <QASummary newPositionValue={newPositionValue} newLTV={newPositionLTV}/>
        </ConfirmModal></>}
    </Card>
    </HStack>
  )
}

export default QuickActionWidget
