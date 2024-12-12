import { Card, Text, Stack, HStack, Input, Button, Slider, SliderTrack, SliderFilledTrack, List, ListItem } from "@chakra-ui/react"
import { TxButton } from "../TxButton"
import useSPCompound from "./hooks/useSPCompound"
import { useEffect, useMemo, useState } from "react"
import useStabilityAssetPool from "../Bid/hooks/useStabilityAssetPool"
import { isGreaterThanZero, num } from "@/helpers/num"
import { useUSDCVaultTokenUnderlying, useEstimatedAnnualInterest, useVaultInfo, useEarnUSDCEstimatedAPR, useEarnUSDCRealizedAPR } from "../Earn/hooks/useEarnQueries"
import useBidState from "../Bid/hooks/useBidState"
import { useAssetBySymbol } from "@/hooks/useAssets"
import useBalance, { useBalanceByAsset } from "@/hooks/useBalance"
import ActModal from "../Earn/ActModal"
import { SliderWithState } from "../Mint/SliderWithState"
import { shiftDigits } from "@/helpers/math"
import useAutoSP from "./hooks/useAutoSP"
import { useBasket } from "@/hooks/useCDP"
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

const NeuroGuardCard = () => {
  const { neuroState, setNeuroState } = useNeuroState()
  const { assets: usableAssets } = neuroState
  
  // Define priority order for specific symbols
  const prioritySymbols = ['BTC', 'stATOM', 'stOSMO']

  const { data: walletBalances } = useBalance()
  const assets = useCollateralAssets()
  const { data: prices } = useOraclePrice()
  
  
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

        //Sort assets by USD value
        // assetsWithBalance.sort((a, b) => {
        //   if (a.combinUsdValue < b.combinUsdValue) return 1
        //   else return -1
        // })

        
        // Sort assets with priority symbols first, then alphabetically
        const sortedAssets = assetsWithBalance.sort((a, b) => {
          const aIndex = prioritySymbols.indexOf(a.symbol??"N/A")
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
          return a.symbol.localeCompare(b.symbol)
      })


        setNeuroState({
          assets: (sortedAssets??[])
        })
      }
  }, [assets, walletBalances, prices])

  const onSliderChange = (value: number) => {
    const max = neuroState?.selectedAsset?.combinUsdValue??0

    if (num(value).isGreaterThan(max)) setNeuroState({ selectedAsset: { ...neuroState?.selectedAsset, sliderValue: max }})
    else setNeuroState({ selectedAsset: { ...neuroState?.selectedAsset, sliderValue: value }})
      
  }
  const onAssetMenuChange = (value: string) => {
    setNeuroState({
      selectedAsset: value
    })
  }

    return (
        <Card width={"100%"} borderColor={""} borderWidth={3} padding={4}>
          <HStack gap={"42%"}>
            {/* <Text variant="title" fontSize={"lg"} letterSpacing={"1px"}  width="35%"> Available CDT Balance: {num(cdtBalance).toFixed(1)}</Text> */}
            { neuroState.selectedAsset?.combinUsdValue && neuroState.selectedAsset?.combinUsdValue < (((neuroState.selectedAsset?.maxBorrowLTV??0) * 0.8) * 101) && <Text variant="title" fontSize={"lg"} letterSpacing={"1px"}  width="35%"> Warning: You are approaching the maximum LTV ratio for this asset</Text>}
            
              <AssetsWithBalanceMenu 
                value={neuroState?.selectedAsset} 
                onChange={onAssetMenuChange}
                assets={usableAssets}
              />
            <NeuroAssetSlider key={neuroState?.selectedAsset?.base} asset={neuroState?.selectedAsset} label={neuroState?.selectedAsset?.symbol} onChangeExt={onSliderChange} />  
           </HStack> 
        </Card>
    )
}

export default NeuroGuardCard