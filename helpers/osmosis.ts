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
}
export const swapToMsg = ({
    address,
    cdtAmount,
    swapToAsset,
}: GetSwapToMsgs) => {
    const { data: prices } = useOraclePrice()
    const cdtAsset = useAssetBySymbol('CDT')
    const microAmount = shiftDigits(cdtAmount, 6).dp(0).toString()

    //Swap to USDC
    const cdtPrice = prices?.find((price) => price.denom === cdtAsset?.base)
    const swapToPrice = prices?.find((price) => price.denom === swapToAsset.base)
    const CDTInAmount = num(microAmount).div(2).toNumber()
    return handleCollateralswaps(address, Number(cdtPrice!.price), Number(swapToPrice!.price), swapToAsset.symbol as keyof exported_supportedAssets, CDTInAmount)
}

type GetLPMsgs = {
    cdtInAmount: string | number
    pairedAssetInAmount:  string | number
    pairedAsset: Asset
    address: string
    poolID: number
    }
export const LPMsg = ({
    address,
    cdtInAmount,
    pairedAssetInAmount,
    pairedAsset,
    poolID,
}: GetLPMsgs) => {
    const cdtAsset = useAssetBySymbol('CDT')

    const CDTCoinIn = coin(cdtInAmount.toString(), cdtAsset?.base!)
    const USDCCoinIn = coin(pairedAssetInAmount.toString(), pairedAsset?.base!)
    return joinCLPools(address, CDTCoinIn, poolID, USDCCoinIn)
}