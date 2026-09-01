import React, { useEffect, useMemo, useState, useCallback } from "react"
import { Button } from "@chakra-ui/react"
import { num } from "@/helpers/num"
import { shiftDigits } from "@/helpers/math"
import { denoms } from "@/config/defaults"
import { useBasket, useBasketAssets, useCollateralInterest, useUserPositions } from "@/hooks/useCDP"
import { simpleBoundedAPRCalc, useBoundedCDTVaultTokenUnderlying, useBoundedTVL, useUserBoundedIntents } from "@/hooks/useEarnQueries"
import { useOraclePrice } from "@/hooks/useOracle"
import useCollateralAssets from "../../Bid/hooks/useCollateralAssets"
import useNeuroState from "./useNeuroState"
import useBalance, { useBalanceByAsset } from "@/hooks/useBalance"
import useAppState from "@/persisted-state/useAppState"
import useNeuroIntentPolish from "./useNeuroIntentPolish"
import useToaster from "@/hooks/useToaster"
import { useAssetBySymbol } from "@/hooks/useAssets"
import useWallet from "@/hooks/useWallet"
import { useChainRoute } from "@/hooks/useChainRoute"

//@ts-ignore
function ToastButton({ isLoading, isDisabled, onClick }) {
  return (
    <Button isDisabled={isDisabled} isLoading={isLoading} onClick={onClick}>
      Polish
    </Button>
  );
}

const useNeuroGuardData = () => {

  const { address } = useWallet()
  const { data: basketPositions } = useUserPositions()

  const { appState } = useAppState()
  const { data: basket } = useBasket(appState.rpcUrl)
  // // console.log("basketPositions", basketPositions)
  const { data: TVL } = useBoundedTVL()
  const { data: userIntents } = useUserBoundedIntents()
  const { setNeuroState } = useNeuroState()

  const neuroStateAssets = useNeuroState(state => state.neuroState.assets);
  const { data: walletBalances } = useBalance()
  const assets = useCollateralAssets()
  const { data: prices } = useOraclePrice()
  // const { data: clRewardList } = getBestCLRange()
  const { data: interest } = useCollateralInterest()
  const { data: basketAssets } = useBasketAssets()
  const { action: polishIntents } = useNeuroIntentPolish()
  const { chainName } = useChainRoute()

  const cdtAsset = useAssetBySymbol('CDT', chainName)
  // const cdtBalance = useBalanceByAsset(cdtAsset) ?? "0"
  const usdcAsset = useAssetBySymbol('USDC', chainName)
  const usdcBalance = useBalanceByAsset(usdcAsset) ?? "0"
  const toaster = useToaster();

  const boundCDTAsset = useAssetBySymbol('range-bound-CDT', chainName)
  const boundCDTBalance = useBalanceByAsset(boundCDTAsset) ?? "1"
  const { data: underlyingData } = useBoundedCDTVaultTokenUnderlying(
    num(shiftDigits(boundCDTBalance, 6)).toFixed(0)
  )

  // Determine if any of these are still loading
  // const areQueriesLoading = [
  //   basketPositions,
  //   basket,
  //   TVL,
  //   userIntents,
  //   walletBalances,
  //   prices,
  //   interest,
  //   basketAssets,
  //   cdtAsset,
  //   usdcAsset,
  //   boundCDTAsset,
  //   boundCDTBalance,
  //   underlyingData
  // ].some(data => data === undefined || data === null);

  const [hasShownToast, setHasShownToast] = useState(false);


  const isDisabled = polishIntents?.simulate.isError || !polishIntents?.simulate.data
  const isLoading = polishIntents?.simulate.isLoading || polishIntents?.tx.isPending

  // Memoize the toggle handler to prevent recreating on each render
  const onClick = useCallback(() => {
    polishIntents?.tx.mutate()
  }, [polishIntents?.tx]);

  //Toast if a msg is ever ready to rock
  useEffect(() => {

    if (!hasShownToast && !isDisabled && !isLoading) {
      toaster.message({
        title: 'Execute to Claim Yield Dust & Re-Activate Intents',
        message: (
          <ToastButton
            isDisabled={isDisabled}
            isLoading={isLoading}
            onClick={onClick}
          />
        ),
        duration: null
      });
      setHasShownToast(true);
    } else if (hasShownToast && !isDisabled && isLoading) {
      toaster.dismiss();
      toaster.message({
        title: 'Execute to Claim Yield Dust & Re-Activate Intents',
        message: (
          <ToastButton
            isDisabled={isDisabled}
            isLoading={isLoading}
            onClick={onClick}
          />
        ),
        duration: null
      });

    }
  }, [isDisabled, isLoading]);


  const calculatedRBYield = useMemo(() => {

    // console.log(" calculatedRBYield")
    if (!basket || !interest || !TVL) return "0";
    // TODO(evm-migration): basket is null-stubbed (no aggregate basket view in Cdp.sol) and
    // useCollateralInterest returns the flat EVM {denom,rate}[] shape, not CollateralInterestResponse.
    return simpleBoundedAPRCalc(shiftDigits((basket as any).credit_asset.amount, -6).toNumber(), interest as any, TVL, 0);
  }, [basket, interest, TVL]);
  // // console.log(calculatedRBYield, basket, interest, TVL)

  ////
  const underlyingCDT = useMemo(() =>
    shiftDigits(underlyingData, -6).toString() ?? "0"
    , [underlyingData])
  ////


  // TODO(evm-migration): basket is null-stubbed; credit_price has no EVM equivalent here yet.
  const cdtMarketPrice = prices?.find((price) => price.denom === denoms.CDT[0])?.price || (basket as any)?.credit_price.price || "1"
  // const usdcPrice = useMemo(() => {
  //   // console.log(" usdcPrice")
  //   return prices?.find((price) => price.denom === denoms.USDC[0])?.price ?? "1"
  // }, [prices])

  // Define priority order for specific symbols
  const prioritySymbols = useMemo(() => ['WBTC.ETH.AXL', 'stATOM', 'stOSMO', 'stTIA'], [])

  ////Get all assets that have a wallet balance///////
  //List of all denoms in the wallet
  const walletDenoms = useMemo(() => {
    return (walletBalances ?? [])
      //@ts-ignore
      .flatMap(coin => num(coin.amount).isGreaterThan(0) ? [coin.denom] : []);
  }, [walletBalances]);

  const sortedAssets = useMemo(() => {
    if (!prices || !walletBalances || !assets || !walletDenoms) return [];

    const assetsPlusCDT = [...assets, {
      base: denoms.CDT[0],
      symbol: "CDT",
      decimal: 6,
      logo: "/images/cdt.svg",
      combinedUsdValue: 1
    }];

    const walletDenomsSet = new Set(walletDenoms);
    // js-combine-iterations: fused the former .flatMap().filter() into a single pass —
    // compute combinUsdValue once and gate inclusion in the same callback instead of a
    // second full traversal.
    return assetsPlusCDT
      .flatMap(asset => {
        if (!asset || !walletDenomsSet.has(asset.base as string)) return []
        const balance = num(shiftDigits((walletBalances?.find((b: any) => b.denom === asset.base)?.amount ?? 0), -(asset?.decimal ?? 6))).toNumber()
        const price = Number(prices?.find((p: any) => p.denom === asset.base)?.price ?? "0")
        const combinUsdValue = num(num(shiftDigits((walletBalances?.find((b: any) => b.denom === asset.base)?.amount ?? 0), -(asset?.decimal ?? 6))).times(num(prices?.find((p: any) => p.denom === asset.base)?.price ?? "0"))).toNumber()
        if (!(combinUsdValue > 1)) return []
        return [{
          ...asset,
          value: asset?.symbol,
          label: asset?.symbol,
          sliderValue: 0,
          balance,
          price,
          combinUsdValue,
        }]
      })
      .sort((a, b) => { // @ts-ignore
        const aIndex = prioritySymbols.indexOf(a.symbol ?? "N/A") // @ts-ignore
        const bIndex = prioritySymbols.indexOf(b.symbol ?? "N/A")

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
      });
  }, [assets, walletBalances, prices, walletDenoms, prioritySymbols]);


  // Update state in a separate effect
  useMemo(() => {

    // console.log(" sortedAssets")
    if (sortedAssets && sortedAssets.length > 0) {
      setNeuroState({
        //@ts-ignore
        assets: sortedAssets ?? []
        // openSelectedAsset: sortedAssets[0] ?? {}
      });
    }
  }, [sortedAssets, setNeuroState]);
  //Iterate thru intents and find all intents that are for NeuroGuard (i.e. have a position ID)
  const neuroGuardIntents = useMemo(() => {
    if (!userIntents?.[0]?.intent?.intents?.purchase_intents) return [];
    return userIntents[0].intent.intents.purchase_intents
      .filter(intent => intent.position_id !== undefined);
  }, [userIntents]);


  // Memoize existing guards calculation
  const existingGuards = useMemo(() => {
    // console.log(" existingGuards")
    // // console.log("userIntents close", userIntents, basket, prices, basketPositions, assets)
    if (userIntents && userIntents[0] && userIntents[0].intent.intents.purchase_intents && basket && prices && basketPositions && assets && basketAssets) {
      // // console.log(" in guards")
      //Iterate thru intents and find all intents that are for NeuroGuard (i.e. have a position ID)
      return neuroGuardIntents.flatMap((intent: any) => {
        // // console.log("big checkers", neuroGuardIntents, intent, basketPositions)
        // TODO(evm-migration): useUserPositions now returns the flat EvmUserPosition[] (no nested
        // `.positions` / CosmWasm `collateral_assets`); read defensively until re-modeled.
        let position = (basketPositions as any)[0]?.positions?.find((position: any) => position.position_id === (intent.position_id ?? 0).toString())
        // // console.log("position", basketPositions[0].positions[0].position_id,(intent.position_id??0).toString(), basketPositions[0].positions[0].position_id === (intent.position_id??0).toString())
        // // console.log("position", position)
        if (position === undefined) return []
        // if (position.credit_amount === "0") return
        let asset = position.collateral_assets[0] //@ts-ignore
        let assetPrice = Number(prices?.find((p: any) => p.denom === asset.asset.info.native_token.denom)?.price ?? "0") //@ts-ignore
        let fullAssetInfo = assets?.find((p: any) => p.base === asset.asset.info.native_token.denom)
        let assetDecimals = fullAssetInfo?.decimal ?? 0
        let assetValue = shiftDigits(asset.asset.amount, -(assetDecimals)).times(assetPrice)
        let creditPrice = (basket as any).credit_price.price
        let creditValue = shiftDigits(position.credit_amount, -6).times(creditPrice)
        let LTV = creditValue.dividedBy(assetValue).toString()


        // // console.log("basketAssets", basketAssets.find((basketAsset) => basketAsset?.asset?.base === asset.asset.info.native_token.denom)?.interestRate , asset.asset.info.native_token.denom, basketAssets)
        return [{
          position: position,
          amount: shiftDigits(asset.asset.amount, -(assetDecimals)),
          symbol: fullAssetInfo?.symbol ?? "N/A", //@ts-ignore
          image: fullAssetInfo?.logo, //@ts-ignore
          cost: basketAssets.find((basketAsset) => basketAsset?.asset?.base === asset.asset.info.native_token.denom)?.interestRate || 0,
          LTV
        }]
      });

    }
    else return []
  }, [basketPositions, userIntents, assets, prices, basket, underlyingCDT, basketAssets, neuroGuardIntents])
  // // console.log("existingGuards", existingGuards)


  //Iterate thru positions and find all positions that aren't for NeuroGuard (i.e. don't have a position ID)
  const nonNeuroGuardPositions = useMemo(() => {
    if (basketPositions) {
      // TODO(evm-migration): flat EvmUserPosition[] has no nested `.positions`; read defensively.
      return ((basketPositions as any)[0]?.positions ?? [])
        .map((position: any, index: number) => ({ position, positionNumber: index + 1 }))
        .filter(({ position }: { position: any }) =>
          neuroGuardIntents.find((intent: any) => (intent.position_id ?? 0).toString() === position.position_id) === undefined
        );
    } else return [
      {
        position: {},
        positionNumber: 0
      }
    ]
  }, [basketPositions, neuroGuardIntents])
  // // console.log("nonNeuroGuardPositions", nonNeuroGuardPositions, basketPositions, neuroGuardIntents)

  return {
    existingGuards,
    boundCDTBalance,
    calculatedRBYield,
    prices,
    nonNeuroGuardPositions,
    cdtMarketPrice,
  }
}

export default useNeuroGuardData
