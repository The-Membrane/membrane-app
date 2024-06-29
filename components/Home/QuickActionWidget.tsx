import { Card, HStack, Stack, Text, Image } from '@chakra-ui/react'
import ConfirmModal from '../ConfirmModal'
import useCollateralAssets from '../Bid/hooks/useCollateralAssets'
import useBalance from '@/hooks/useBalance'
import useQuickActionState from './hooks/useQuickActionState'
import { useEffect, useMemo, useState } from 'react'
import { num, shiftDigits } from '@/helpers/num'
import { Coin } from '@cosmjs/stargate'
import { useOraclePrice } from '@/hooks/useOracle'
import useQuickAction from './hooks/useQuickAction'
import { QASummary } from './QASummary'
import useWallet from '@/hooks/useWallet'
import { ConnectButton } from '../WallectConnect'
import { SliderWithInputBox } from './QuickActionSliderInput'
import Divider from '../Divider'
import useQuickActionVaultSummary from './hooks/useQuickActionVaultSummary'
import { SWAP_SLIPPAGE } from '@/config/defaults'

const QuickActionWidget = () => {

  const { quickActionState, setQuickActionState } = useQuickActionState()

  const { isWalletConnected, address } = useWallet("osmosis")

  const { data: walletBalances } = useBalance("osmosis")
  const assets = useCollateralAssets()
  const { data: prices } = useOraclePrice()
  const { action: quickAction, loop, newPositionValue, swapRatio, summary } = useQuickAction()

  
  const WalletBalances = useMemo(() => { return walletBalances }, [walletBalances])
  const Assets = useMemo(() => { return assets }, [assets])
  const Prices = useMemo(() => { return prices }, [prices])
  const Summary = useMemo(() => {  return summary }, [summary])
  const QAAssets = useMemo(() => { return quickActionState?.assets }, [quickActionState?.assets])
  const LevAsset = useMemo(() => { return quickActionState?.levAsset }, [quickActionState?.levAsset])
  
  //Set QAState summary within a Memo
  useEffect(() => {
    if (quickActionState.summary && quickActionState.summary != summary){
      console.log("BANG BANG BANG")
      setQuickActionState({ summary })
    }
  },[Summary])

  const { cost, liqudationLTV } = useQuickActionVaultSummary()
  
  const drawdown = useMemo(() => {
      console.log("BOOM BOOM")
    //new ratio post max vol drawdown
    const volRatio = num(45).dividedBy(num(liqudationLTV)).times(358).dividedBy(
      num(45).dividedBy(num(liqudationLTV)).times(358).plus(44.4)
    )
    const stableRatio = volRatio.minus(1).abs()

    //Calc new LTV post drawdown
    const newLTV = volRatio.times(liqudationLTV).plus(stableRatio.times(96))
    // console.log( "drawdown:", volRatio, stableRatio, newLTV)
    return num(45).dividedBy(newLTV).minus(1).abs().times(100).toFixed(1)
  }, [liqudationLTV])
  
  const [ inputAmount, setInputAmount ] = useState(0);
  
  ////Get all assets that have a wallet balance///////
  //List of all denoms in the wallet
  const walletDenoms = (walletBalances??[]).map((coin: Coin) => {
    if (num(coin.amount).isGreaterThan(0)) return coin.denom
    else return ""
  }).filter((asset: string) => asset != "");

  //Create an object of assets that only holds assets that have a walletBalance
  useMemo(() => {
    console.log("BOOM BOOM BANG")  
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
        })
        .filter((asset) => {
          if (!asset) return false
           //This helps us decrease the menu size by removing dust
           //Technically we could do anything under $110 as that's the minimum but for new users that adds confusion
          if (asset.combinUsdValue < 1) return false
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
  }, [Assets, WalletBalances, Prices, address])


  //Split assets w/ balance into leveraged and stable assets
  const { levAssets, stableAssets } = useMemo(() => {
    console.log("here")

    const levAssets = (quickActionState?.assets??[]).filter((asset) => {
      if (asset === undefined) return false
      if (asset.isLP || asset.symbol === "USDC" || asset.symbol === "USDT" || asset.symbol === "USDC.axl") return false
      else return true
    })

    const stableAssets = (quickActionState?.assets??[]).filter((asset) => {
      if (asset === undefined) return false
      if (asset.symbol === "USDC" || asset.symbol === "USDT") return true
      else return false
    })

    return { levAssets, stableAssets }

  }, [QAAssets])
  //
  useEffect(() => {
    console.log("here we go again")
    if (!quickActionState?.levAsset && (quickActionState?.assets??[]).length > 0) {
      setQuickActionState({
        levAsset:  quickActionState?.assets[0], 
      })
    }
  }, [QAAssets, WalletBalances])
  
  useEffect(() => {
    console.log("here we go agina agin")
    if (!quickActionState?.stableAsset && stableAssets.length > 0) {
      setQuickActionState({
        stableAsset:  stableAssets[0], 
      })
    }
  }, [QAAssets, walletBalances])
  
  const onLevAssetMenuChange = (value: string) => {
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
    
  }, [QAAssets, LevAsset?.symbol])

  // console.log(quickAction?.simulate.errorMessage, quickAction?.simulate.isError, !quickAction?.simulate.data)
  // console.log("lev asset", LevAsset?.amount, LevAsset?.amount !== 0)

  ///////Basic Onboarding Card///////
  return (
    <HStack justifyContent="center">
    <Card w="384px" alignItems="center" justifyContent="space-between" p="8" gap="0">
        {!isWalletConnected ? 
        <ConnectButton marginTop={1}/>
        : quickActionState.readyToLoop ?
        <Stack> 
          <Text variant="title" fontSize="16px" marginTop={1} marginBottom={1} textAlign={"center"} letterSpacing={"1px"}>
            Collateral deposited! Ready to loop your position?
          </Text>
          <ConfirmModal 
          action={loop}
          label={"Loop"}
          // isDisabled={(LevAsset?.sliderValue??0 + (quickActionState.stableAsset?.sliderValue??0)) < 222}
          >
            {/* <QASummary newPositionValue={parseInt(newPositionValue.toFixed(0))} swapRatio={swapRatio} summary={summary}/> */}
          </ConfirmModal>
        </Stack>
        : QAAssets.length === 0 ? 
        <Text variant="body" fontSize="16px" marginTop={1}>
            Loading your available collateral assets...
        </Text>
        : levAssets.length === 0 ?
        <Text fontSize="sm" color="white" mt="2" minH="21px">
          This tool only accepts volatile assets as collateral. Check the Mint tab to use stablecoins & bundles.
          {/* Add Onboarding Button here */}
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
            max={LevAsset?.combinUsdValue??0}
            inputBoxWidth='42%'
            assets={levAssets}
            QAState={quickActionState}
            setQAState={setQuickActionState}
            onMenuChange={onLevAssetMenuChange}
            inputAmount={inputAmount}
            setInputAmount={setInputAmount}
        />
        <Card>
          <HStack>
            <Text fontWeight="bold" fontSize="16px">
              {LevAsset?.symbol??"N/A"} 
            </Text>
            <Image src={LevAsset?.logo} w="24px" h="24px" />    
            <Text fontSize="sm" color="white" mt="0" minH="21px">
              : {num(parseInt(newPositionValue.toFixed(0))??0).div(LevAsset?.sliderValue??0).multipliedBy(100).toFixed(0) === 'NaN' ? 0 : (num(parseInt(newPositionValue.toFixed(0))??0).minus(num(LevAsset?.sliderValue).times(swapRatio))).div(LevAsset?.sliderValue??0).multipliedBy(100).toFixed(0)}% Leverage
            </Text>
          </HStack>
          <Text fontSize="sm" color="white" mt="2" minH="21px">
              <span style={{fontWeight:"bold"}}>Drawdown Safety:</span> {drawdown === "NaN" ? 0 : `~${drawdown}`}%
          </Text>
          <Text fontSize="sm" color="white" mt="2" minH="21px">
            <span style={{fontWeight:"bold"}}>Cost:</span> {cost.toFixed(4)}%
          </Text>
          <Divider mx="0" mt="2" mb="2"/>
          <Text fontSize="sm" color="white" mt="2" minH="21px">
          max {SWAP_SLIPPAGE}% slippage when swapping 20% to USDC
          </Text>
        </Card>
         {((LevAsset?.sliderValue??0 < 222) && (LevAsset?.sliderValue??0) != 0) ? <Text fontSize="sm" color="red.500" mt="2" minH="21px">
            Minimum to leverage: $222. Please add more collateral.
          </Text>
          : levAssets.length === 0 ?
          <Text fontSize="sm" color="red.500" mt="2" minH="21px">
            No available collateral assets in your wallet. 
            {/* Add Onboarding Button here */}
          </Text>
          : null }
        </Stack>

        {/* Leverage Button */}
        <ConfirmModal 
        action={quickAction}
        label={"Begin Degeneracy"}
        isDisabled={(LevAsset?.sliderValue??0) < 222}
        >
          <QASummary newPositionValue={parseInt(newPositionValue.toFixed(0))} swapRatio={swapRatio} summary={Summary}/>
        </ConfirmModal></>}
    </Card>
    </HStack>
  )
}

export default QuickActionWidget
