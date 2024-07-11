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

  const { cost, liqudationLTV, borrowLTV } = useQuickActionVaultSummary()
  const { action: quickAction, loop, newPositionValue, summary } = useQuickAction({ borrowLTV })

  
  const WalletBalances = useMemo(() => { return walletBalances }, [walletBalances])
  const Assets = useMemo(() => { return assets }, [assets])
  const Prices = useMemo(() => { return prices }, [prices])
  const Summary = useMemo(() => {  return summary }, [summary])
  const QAAssets = useMemo(() => { return quickActionState?.assets }, [quickActionState?.assets])
  const LevAssets = useMemo(() => { return quickActionState?.levAssets }, [quickActionState?.levAssets])
  // console.log("la", LevAssets, LevSymbols);
  
  //Set QAState summary within a Memo
  useEffect(() => {
    if (quickActionState.summary && quickActionState.summary != summary){
      console.log("BANG BANG BANG")
      setQuickActionState({ summary })
    }
  },[Summary])
  
  const drawdown = useMemo(() => {
      console.log("BOOM BOOM", borrowLTV, liqudationLTV)
    if (borrowLTV === 0 || borrowLTV === "NaN" ||  liqudationLTV === 0 || liqudationLTV === "NaN") return 0
    return num(Math.min(borrowLTV, 45)).dividedBy(liqudationLTV).minus(1).abs().times(100).toFixed(1)
  }, [borrowLTV, liqudationLTV])
  
  const [ inputAmounts, setInputAmount ] = useState([0]);
  
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
    if (!quickActionState?.levAssets && (quickActionState?.assets??[]).length > 0) {
      setQuickActionState({
        levAssets:  [levAssets[0]], 
      })
    }
  }, [QAAssets, WalletBalances])
  
  useEffect(() => {
    if (!quickActionState?.stableAsset && stableAssets.length > 0) {
      setQuickActionState({
        stableAsset:  stableAssets[0], 
      })
    }
  }, [QAAssets, WalletBalances])
  
  const onLevAssetMenuChange = (value: string, index: number) => {
    if (!quickActionState?.levAssets) return
    //@ts-ignore
    quickActionState.levAssets[index] = value
    //
    //Set
    setQuickActionState({
      levAssets: quickActionState?.levAssets
    })
  }

  //This will likely need to be refactored to handle multiple assets
  //We should jsut do this in the AssetSlider component
  useEffect(() => {
    if (quickActionState?.assets && quickActionState?.levAssets?.[0].symbol != undefined) {
      console.log("attempting to find asset", quickActionState?.levAssets,  quickActionState?.assets)
      for (let i = 0; i < quickActionState?.levAssets?.length; i++) {
        let found = quickActionState?.assets.find((asset) => asset.symbol === quickActionState?.levAssets?.[i].symbol)
        if(found) quickActionState.levAssets[i] = found
        console.log(i, found)
      }
      // let found = quickActionState?.assets.find((asset) => asset.symbol === quickActionState?.levAssets?.[0].symbol)
      // if(found) quickActionState.levAssets[0] = found

      setQuickActionState({
        levAssets: quickActionState.levAssets,
      })
    }
    
  }, [QAAssets])


  const [addAssetStyle, setAddAssetStyle] = useState({display: "flex"})

  const newLevAsset = () => {
    if (!assets || assets.length === 0 || !quickActionState?.levAssets) return
    //Get lev asset denoms
    let levDenoms = quickActionState?.levAssets?.map((asset) => asset.base)
    var newAssets = levAssets.filter((asset) => {
      if (!asset) return false
      if (levDenoms.includes(asset.base) ) return false
      else return true
    })
    //Add new levAssets
    if (newAssets.length > 0) quickActionState?.levAssets?.push(newAssets[0])
    if (newAssets.length === 1) {
      setAddAssetStyle({display: "none"})
      newAssets = []
    }
    //Set new assets
    setQuickActionState({
      levAssets: quickActionState?.levAssets,
      // assets: newAssets,
    })
  }

  ///////Basic Onboarding Card///////
  return (
    <HStack justifyContent="center">
    <Card w="100%" alignItems="center" justifyContent="space-between" p="8" gap="0">
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
          // isDisabled={(LevAssets?.sliderValue??0 + (quickActionState.stableAsset?.sliderValue??0)) < 222}
          >
            {/* <QASummary newPositionValue={parseInt(newPositionValue.toFixed(0))} swapRatio={swapRatio} summary={summary}/> */}
          </ConfirmModal>
        </Stack>
        : QAAssets.length === 0 && !LevAssets?.[0].symbol ? 
        <Text variant="body" fontSize="16px" marginTop={1}>
            Loading your available collateral assets...
        </Text>
        : levAssets.length === 0 && (LevAssets?.length??[]) === 0 ?
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
            max={LevAssets?.[0].combinUsdValue??0}
            inputBoxWidth='42%'
            assets={levAssets.filter((asset) => LevAssets?.map((asset) => asset.symbol)?.includes(asset.symbol) === false)}
            QAState={quickActionState}
            setQAState={setQuickActionState}
            onMenuChange={onLevAssetMenuChange}
            inputAmounts={inputAmounts}
            setInputAmounts={setInputAmount}
            levAssetIndex={0}
        />
        {quickActionState?.levAssets && quickActionState?.levAssets?.length > 1 ? <>
          {/* Map new sliders for new assets */}
          {quickActionState?.levAssets?.slice(1).map((asset, index) => {
            return <SliderWithInputBox
            key={asset.symbol}
            max={asset.combinUsdValue??0}
            inputBoxWidth='42%'
            assets={levAssets.filter((asset) => LevAssets?.map((asset) => asset.symbol)?.includes(asset.symbol) === false)}
            QAState={quickActionState}
            setQAState={setQuickActionState}
            onMenuChange={onLevAssetMenuChange}
            inputAmounts={inputAmounts}
            setInputAmounts={setInputAmount} 
            levAssetIndex={index+1}/>
         })}</> : null}
        <Text style={addAssetStyle} cursor="pointer" fontSize="14px" textDecoration={"underline"} onClick={newLevAsset} justifyContent={"center"}>
          Add Asset
        </Text> 
        <Card>  
          <HStack>
            <Text fontWeight="bold" fontSize="16px">
              {LevAssets?.[0].symbol??"N/A"} 
            </Text>
            <Image src={LevAssets?.[0].logo} w="24px" h="24px" />    
            <Text fontSize="sm" color="white" mt="0" minH="21px">
              : {num(parseInt(newPositionValue.toFixed(0))??0).div((LevAssets?.map((asset) => asset.sliderValue??0).reduce((a, b) => a + b, 0)??0)).multipliedBy(100).toFixed(0) === 'NaN' ? 0 : num(parseInt(newPositionValue.toFixed(0))??0).div((LevAssets?.map((asset) => asset.sliderValue??0).reduce((a, b) => a + b, 0)??0)).multipliedBy(100).toFixed(0)}% Leverage
            </Text>
          </HStack>
          <Text fontSize="sm" color="white" mt="2" minH="21px">
              <span style={{fontWeight:"bold"}}>Drawdown Safety:</span> {`~${drawdown}`}%
          </Text>
          <Text fontSize="sm" color="white" mt="2" minH="21px">
            <span style={{fontWeight:"bold"}}>Cost:</span> {cost.toFixed(4)}% / year
          </Text>
          <Divider mx="0" mt="2" mb="2"/>
          <Text fontSize="sm" color="white" mt="2" minH="21px">
          max {SWAP_SLIPPAGE}% slippage when looping
          </Text>
        </Card>
         {((LevAssets?.[0].sliderValue??0 < 222) && (LevAssets?.[0].sliderValue??0) != 0) ? <Text fontSize="sm" color="red.500" mt="2" minH="21px">
            Minimum to leverage: $222. Please add more collateral.
          </Text>
          : levAssets.length === 0 && (LevAssets?.length??[]) === 0 ?
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
        isDisabled={(LevAssets?.map((asset) => asset.sliderValue??0).reduce((a, b) => a + b, 0)??0) < 222}
        >
          <QASummary newPositionValue={parseInt(newPositionValue.toFixed(0))} summary={Summary}/>
        </ConfirmModal></>}
    </Card>
    </HStack>
  )
}

export default QuickActionWidget
