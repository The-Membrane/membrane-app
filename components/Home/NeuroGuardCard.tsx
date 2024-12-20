import { Card, Text, Stack, HStack, Input, Button, Slider, SliderTrack, SliderFilledTrack, List, ListItem } from "@chakra-ui/react"
import { TxButton } from "../TxButton"
import useSPCompound from "./hooks/useSPCompound"
import { useEffect, useMemo, useState } from "react"
import useStabilityAssetPool from "../Bid/hooks/useStabilityAssetPool"
import { isGreaterThanZero, num } from "@/helpers/num"
import { useUSDCVaultTokenUnderlying, useEstimatedAnnualInterest, useVaultInfo, useEarnUSDCEstimatedAPR, useEarnUSDCRealizedAPR, useBoundedTVL } from "../Earn/hooks/useEarnQueries"
import useBidState from "../Bid/hooks/useBidState"
import { useAssetBySymbol } from "@/hooks/useAssets"
import useBalance, { useBalanceByAsset } from "@/hooks/useBalance"
import ActModal from "../Earn/ActModal"
import { SliderWithState } from "../Mint/SliderWithState"
import { shiftDigits } from "@/helpers/math"
import useAutoSP from "./hooks/useAutoSP"
import { useBasket, useUserPositions } from "@/hooks/useCDP"
import Divider from "../Divider"
import React from "react"
import ConfirmModal from "../ConfirmModal"
import { QASummary } from "./QASummary"
import { GrPowerReset } from "react-icons/gr"
import useMintState from "../Mint/hooks/useMintState"
import useCombinBalance from "../Mint/hooks/useCombinBalance"
import { getAssetWithNonZeroValues } from "../Mint/CollateralAssets"
import useNeuroState from "./hooks/useNeuroState"
import { AssetsWithBalanceMenu } from "../NFT/NFTSliderInput"
import useCollateralAssets from "../Bid/hooks/useCollateralAssets"
import { useOraclePrice } from "@/hooks/useOracle"
import { Coin } from '@cosmjs/stargate'
import { NeuroAssetSlider } from "./NeuroAssetSlider"
import {useBoundedIntents } from "../Earn/hooks/useEarnQueries"
import { getBestCLRange } from "@/services/osmosis"
import { LPJoinDate } from "@/config/defaults"
import useNeuroGuard from "./hooks/useNeuroGuard"
import useNeuroClose from "./hooks/useNeuroClose"


const NeuroGuardCloseButton = ({ guardedPosition, RBYield }:{ guardedPosition: any, RBYield: any }) => {
    const { action: sheathe } = useNeuroClose({ position: guardedPosition.position })

  
    return (<Card key={guardedPosition.position.position_id} width={"100%"} borderColor={""} borderWidth={3} padding={4}>
      <HStack gap={"4%"}>
        <Text variant="title" fontSize={"lg"} letterSpacing={"1px"} width="35%"> {guardedPosition.symbol} earning {num(RBYield).times(guardedPosition.LTV).toFixed(1)}%</Text>
      <TxButton
        maxW="100%"
        isLoading={sheathe?.simulate.isLoading || sheathe?.tx.isPending}
        isDisabled={sheathe?.simulate.isError || !sheathe?.simulate.data}
        onClick={() => sheathe?.tx.mutate()}
        toggleConnectLabel={false}
        style={{ alignSelf: "center" }}
      >
        Sheathe
      </TxButton>
      </HStack>
  </Card>)

}

const NeuroGuardCard = () => {
  const { data: basketPositions } = useUserPositions() 
  const { data: basket } = useBasket()
  const { data: TVL } = useBoundedTVL()  
  const { data: userIntents } = useBoundedIntents()
  const { neuroState, setNeuroState } = useNeuroState()
  const { assets: usableAssets } = neuroState
  const { action: neuro } = useNeuroGuard()
  
  // Define priority order for specific symbols
  const prioritySymbols = ['BTC', 'stATOM', 'stOSMO']

  const { data: walletBalances } = useBalance()
  const assets = useCollateralAssets()
  const { data: prices } = useOraclePrice()

  
  const { bidState } = useBidState()
  const { data: clRewardList } = getBestCLRange()
  const daysSinceDeposit = num(Date.now() - LPJoinDate.getTime()).dividedBy(1000).dividedBy(86400).toNumber()
  const rangeBoundAPR = useMemo(() => {
      //upperXlower & middle are just for logs rn
      if (!clRewardList) return 0

      const totalrewards = ( clRewardList[2].reward + clRewardList[3].reward + clRewardList[4].reward + clRewardList[10].reward + clRewardList[11].reward + clRewardList[12].reward) / 6
      // const middleAPR = ((clRewardList[5].reward + clRewardList[6].reward + clRewardList[7].reward + clRewardList[8].reward + clRewardList[9].reward) / 5) / 1000000 / daysSinceDeposit * 365
      return totalrewards / 1000000 / daysSinceDeposit * 365
  }, [clRewardList])
  const rblpYield = useMemo(() => {
    console.log("rblpYield", rangeBoundAPR, bidState.cdpExpectedAnnualRevenue, TVL)
    if (bidState.cdpExpectedAnnualRevenue)
      num(bidState.cdpExpectedAnnualRevenue).times(0.80).dividedBy(TVL || 1).plus(rangeBoundAPR).multipliedBy(100).toFixed(1)
    else return "0"
  }, [rangeBoundAPR, bidState.cdpExpectedAnnualRevenue, TVL])
  
  const yieldMsg = useMemo(() => {
    console.log("yieldMsg", neuroState?.selectedAsset, rangeBoundAPR, bidState.cdpExpectedAnnualRevenue, TVL)
    if (neuroState?.selectedAsset && bidState.cdpExpectedAnnualRevenue && TVL && rangeBoundAPR)
      return <Text variant="title" fontSize={"lg"} letterSpacing={"1px"} width="35%"> {neuroState?.selectedAsset?.symbol} could be earning {num(
        num(bidState.cdpExpectedAnnualRevenue).times(0.80).dividedBy(TVL || 1).plus(rangeBoundAPR).multipliedBy(100).toFixed(1)
      ).times(neuroState?.selectedAsset?.maxBorrowLTV??0).times(0.80).toFixed(1)}%</Text>
    else return <Text variant="title" fontSize={"lg"} letterSpacing={"1px"} width="35%"> Select an asset to see potential yield </Text>
  }, [rblpYield, neuroState?.selectedAsset])

  //Create an object for all positions that have an intent to compound
  const existingGuards = useMemo(() => {
    console.log("userIntents close", userIntents, basket, prices, basketPositions, assets)
    if (userIntents && userIntents[0].intent.intents.purchase_intents && basket && prices && basketPositions && assets) {
      //Iterate thru intents and find all intents that are for NeuroGuard (i.e. have a position ID)
      const neuroGuardIntents = userIntents[0].intent.intents.purchase_intents.filter((intent) => {
        return intent.position_id !== undefined
      })

      //If there are neuroGuardIntents, create an object that saves the ID, the compounding asset & the LTV
      return neuroGuardIntents.map((intent) => {
        let position = basketPositions[0].positions.find((position) => { position.position_id === (intent.position_id!.toString()) })!
        let asset = position.collateral_assets[0] //@ts-ignore
        let assetPrice = Number(prices?.find((p: any) => p.denom === asset.asset.native_token.denom)?.price??"0") //@ts-ignore
        let fullAssetInfo = assets?.find((p: any) => p.base === asset.asset.native_token.denom)
        let assetDecimals = fullAssetInfo?.decimal??0
        let assetValue = shiftDigits(asset.asset.amount, -(assetDecimals)).times(assetPrice)
        let creditPrice = basket.credit_price.price
        let creditValue = shiftDigits(position.credit_amount, -6).times(creditPrice)
        let LTV = creditValue.dividedBy(assetValue)

        return {
          position: position,
          asset, //May not need this
          symbol: fullAssetInfo?.symbol,
          LTV
        }
      })

    } else return []
  }, [basketPositions, userIntents, assets, prices, basket])
  
  
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
        }) 
        //Filter out assets with zero balance
        .filter((asset) => asset?.combinUsdValue??0 > 1)
        
        // Sort assets with priority symbols first, then alphabetically
        const sortedAssets = assetsWithBalance.sort((a, b) => { // @ts-ignore
          const aIndex = prioritySymbols.indexOf(a.symbol??"N/A") // @ts-ignore
          const bIndex = prioritySymbols.indexOf(b.symbol??"N/A")
          
          // If both assets are in priority list, sort by priority order
          if (aIndex !== -1 && bIndex !== -1) {
              return aIndex - bIndex
          }
          // If only first asset is in priority list, it comes first
          if (aIndex !== -1) {
              return -1
          }
          // If only second asset is in priority list, it comes first
          if (bIndex !== -1) {
              return 1
          }
          // For non-priority assets, sort alphabetically by symbol 
          // @ts-ignore
          return a.symbol.localeCompare(b.symbol)
      })


        setNeuroState({
          // @ts-ignore
          assets: (sortedAssets??[]),
          // @ts-ignore
          selectedAsset: sortedAssets[0]??{}
        })
      }
  }, [assets, walletBalances, prices])

  const onSliderChange = (value: number) => {
    const max = neuroState?.selectedAsset?.combinUsdValue??0

      // @ts-ignore
    if (num(value).isGreaterThan(max)) setNeuroState({ selectedAsset: { ...neuroState?.selectedAsset, sliderValue: max }})
      // @ts-ignore
    else setNeuroState({ selectedAsset: { ...neuroState?.selectedAsset, sliderValue: value }})
      
  }
  const onAssetMenuChange = (value: string) => {
    setNeuroState({
      // @ts-ignore
      selectedAsset: value
    })
  }


  // const isDisabled = useMemo(() => {return neuro?.simulate.isError || !neuro?.simulate.data }, [neuro?.simulate.isError, neuro?.simulate.data])
  console.log("neuro error", neuro?.simulate.error, neuro?.simulate.isError, !neuro?.simulate.data)
    return (
      <>
        {existingGuards.map((guard) => 
          <NeuroGuardCloseButton guardedPosition={guard.position} RBYield={rblpYield}/>
        )}
        <Card width={"100%"} borderColor={""} borderWidth={3} padding={4}>
          <HStack gap={"4%"}>
            { neuroState.selectedAsset?.combinUsdValue && neuroState.selectedAsset?.combinUsdValue < (101 / ((neuroState.selectedAsset?.maxBorrowLTV??0) * 0.8)) && 
            <Text variant="title" fontSize={"lg"} letterSpacing={"1px"}  width="35%"> Requirements not met: The deposit minimum for this asset is ${101 / ((neuroState.selectedAsset?.maxBorrowLTV??0) * 0.8)}</Text>}
            
            <AssetsWithBalanceMenu 
              value={neuroState?.selectedAsset} 
              onChange={onAssetMenuChange}
              assets={usableAssets}
            />
              {/* @ts-ignore */}
            <NeuroAssetSlider key={neuroState?.selectedAsset?.base} asset={neuroState?.selectedAsset} label={neuroState?.selectedAsset?.symbol} onChangeExt={onSliderChange} />  
            {yieldMsg}
            
            <TxButton
              maxW="100%"
              isLoading={neuro?.simulate.isLoading || neuro?.tx.isPending}
              isDisabled={neuro?.simulate.isError || !neuro?.simulate.data}
              onClick={() => neuro?.tx.mutate()}
              toggleConnectLabel={false}
              style={{ alignSelf: "center" }}
            >
              En Guard
            </TxButton>
           </HStack> 
        </Card>
      </>
    )
}

export default NeuroGuardCard