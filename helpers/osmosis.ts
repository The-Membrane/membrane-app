import { Price } from "@/services/oracle"
import { handleCollateralswaps, joinCLPools } from "@/services/osmosis"
import { shiftDigits } from "./math"
import { Asset, exported_supportedAssets } from "./chain"
import { useAssetBySymbol } from "@/hooks/useAssets"
import { num } from "./num"
import { coin } from "@cosmjs/stargate"
import { useOraclePrice } from "@/hooks/useOracle"

type GetSwapToMsgs = {
    cdtAmount: string | number
    swapToAsset: Asset
    address: string
    prices: Price[]
    cdtPrice: number
}
export const swapToMsg = ({
    address,
    cdtAmount,
    swapToAsset,
    prices,
    cdtPrice
}: GetSwapToMsgs) => {
    const microAmount = shiftDigits(cdtAmount, 6).dp(0).toString()

    //Swap to USDC
    const swapToPrice = prices?.find((price) => price.denom === swapToAsset.base)
    const CDTInAmount = num(microAmount).div(2).toNumber()

    return handleCollateralswaps(address, cdtPrice, Number(swapToPrice!.price), swapToAsset.symbol as keyof exported_supportedAssets, CDTInAmount)
}

type GetLPMsgs = {
    cdtInAmount: string | number
    cdtAsset: Asset
    pairedAssetInAmount:  string | number
    pairedAsset: Asset
    address: string
    poolID: number
    }
export const LPMsg = ({
    address,
    cdtInAmount,
    cdtAsset,
    pairedAssetInAmount,
    pairedAsset,
    poolID,
}: GetLPMsgs) => {
    const CDTCoinIn = coin(cdtInAmount.toString(), cdtAsset.base)
    const USDCCoinIn = coin(pairedAssetInAmount.toString(), pairedAsset.base)
    console.log("made it 1", CDTCoinIn, USDCCoinIn, poolID)
    return joinCLPools(address, CDTCoinIn, poolID, USDCCoinIn)
}