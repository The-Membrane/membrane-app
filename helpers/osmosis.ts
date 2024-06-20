import { Price } from "@/services/oracle"
import { handleCDTswaps, handleCollateralswaps, joinCLPools } from "@/services/osmosis"
import { shiftDigits } from "./math"
import { Asset, exported_supportedAssets } from "./chain"
import { num } from "./num"
import { coin } from "@cosmjs/stargate"

type GetSwapToMsgs = {
    cdtAmount: string | number
    swapToAsset: Asset
    address: string
    prices: Price[]
    cdtPrice: number
}
export const swapToCollateralMsg = ({
    address,
    cdtAmount,
    swapToAsset,
    prices,
    cdtPrice
}: GetSwapToMsgs) => {
    const microAmount = shiftDigits(cdtAmount, 6).dp(0).toString()

    //Swap to Asset from CDT
    const swapToPrice = prices?.find((price) => price.denom === swapToAsset.base)
    const CDTInAmount = num(microAmount).toNumber()

    return handleCollateralswaps(address, cdtPrice, Number(swapToPrice!.price), swapToAsset.symbol as keyof exported_supportedAssets, CDTInAmount)
}

type GetSwapFromMsgs = {
    swapFromAmount: string | number
    swapFromAsset: Asset
    address: string
    prices: Price[]
    cdtPrice: number
}
export const swapToCDTMsg = ({
    address,
    swapFromAmount,
    swapFromAsset,
    prices,
    cdtPrice
}: GetSwapFromMsgs) => {
    const microAmount = shiftDigits(swapFromAmount, swapFromAsset.decimal).dp(0).toString()

    //Swap to CDT from Asset
    const swapFromPrice = prices?.find((price) => price.denom === swapFromAsset.base)
    console.log("swapFromPrice", swapFromPrice, swapFromAsset.symbol)
    const scaledSwapFromAmount = num(microAmount).toNumber()

    return handleCDTswaps(address, cdtPrice, Number(swapFromPrice!.price), swapFromAsset.symbol as keyof exported_supportedAssets, scaledSwapFromAmount)
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
    return joinCLPools(address, CDTCoinIn, poolID, USDCCoinIn)
}