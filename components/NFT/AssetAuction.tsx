import { Card, HStack, Text, Stack } from "@chakra-ui/react"
import { SliderWithState } from "../Mint/SliderWithState"
import { useAssetBySymbol } from "@/hooks/useAssets"
import { useBalanceByAsset } from "@/hooks/useBalance"
import useNFTState from "./hooks/useNFTState"
import { isGreaterThanZero, num } from "@/helpers/num"
import { TxButton } from "../TxButton"
import useLiveAssetBid from "./hooks/useLiveAssetBid"
import { shiftDigits } from "@/helpers/math"
import { useEffect, useState } from "react"
import { Asset, getAssetBySymbol } from "@/helpers/chain"
import { useOraclePrice } from "@/hooks/useOracle"
import { Price } from "@/services/oracle"
import Countdown from "../Countdown"
import React from "react"
import { useChainRoute } from "@/hooks/useChainRoute"

interface Prop {
    currentBid: any,
    auctionAmount: any,
    auctionEndTime: number,
    assetBidAmount: number
}

const getMBRNPrice = (prices: Price[] | null | undefined, MBRN: Asset) => {
    const price = prices?.find((price) => price.denom === MBRN?.base)
    if (!price) return '0'
    return parseFloat((price.price)).toFixed(4)
}
const getCDTPrice = (prices: Price[] | null | undefined, cdt: Asset) => {
    const price = prices?.find((price) => price.denom === cdt?.base)
    if (!price) return '0'
    return parseFloat((price.price)).toFixed(4)
}

const AssetAuction = React.memo(function AssetAuction({ currentBid, auctionAmount, auctionEndTime, assetBidAmount }: Prop) {
    console.log("AssetAuction rerender")

    const { setNFTState } = useNFTState()
    const bid = useLiveAssetBid(assetBidAmount)
    //Bid Auctions end when the current NFT auction does

    const stargazeMBRN = useAssetBySymbol('MBRN', 'stargaze')
    const stargazeMBRNBalance = useBalanceByAsset(stargazeMBRN, 'stargaze')

    const { data: prices } = useOraclePrice()
    const { chainName } = useChainRoute()
    const CDT = getAssetBySymbol('CDT', chainName)
    const MBRN = getAssetBySymbol('MBRN', chainName)
    const [tokenPrices, setTokenPrices] = useState({ cdtPrice: '0', mbrnPrice: '0' })
    const { cdtPrice, mbrnPrice } = tokenPrices
    useEffect(() => {
        // Consolidated into one functional update (instead of two setState calls whose
        // own state was also in the deps below) so the effect no longer re-fires on the
        // state it just wrote. "Keep last non-zero price" behavior is unchanged.
        setTokenPrices(prev => {
            const CDTprice = getCDTPrice(prices, CDT!)
            const MBRNprice = getMBRNPrice(prices, MBRN!)
            const next = { ...prev }
            if (CDTprice != prev.cdtPrice && CDTprice != '0') next.cdtPrice = CDTprice
            if (MBRNprice != prev.mbrnPrice && MBRNprice != '0') next.mbrnPrice = MBRNprice
            return next.cdtPrice === prev.cdtPrice && next.mbrnPrice === prev.mbrnPrice ? prev : next
        })
    }, [prices, CDT, MBRN])

    const onBidChange = (value: number) => {
        setNFTState({ assetBidAmount: value })
    }

    if (!auctionAmount) return null

    return (
        <Stack w="full" gap="5">
            <Text variant="title">ASSET AUCTION</Text>
            <Card w="full" p="8" marginTop={"5.1%"} alignItems="center" gap={5} h={{ base: "100%", md: "28%" }} justifyContent="space-between">
                <Stack w="full" gap="1">
                    <Text fontSize="16px" fontWeight="700">
                        Auction for {shiftDigits(auctionAmount ?? 0, -6).toString()} CDT
                        —— equivalent to {num(cdtPrice).dividedBy(num(mbrnPrice)).multipliedBy(shiftDigits(auctionAmount ?? 0, -6)).toFixed(2)} MBRN
                    </Text>
                    <Text fontSize="16px" fontWeight="700">
                        Current Bid: {shiftDigits(currentBid ?? 0, -6).toString()} MBRN
                    </Text>
                    <Countdown timestamp={auctionEndTime} />
                    <HStack justifyContent="space-between">
                        <Text fontSize="16px" fontWeight="700">
                            MBRN
                        </Text>
                        <Text fontSize="16px" fontWeight="700">
                            {assetBidAmount}
                        </Text>
                    </HStack>
                    <SliderWithState
                        value={assetBidAmount}
                        onChange={onBidChange}
                        min={0}
                        max={Number(stargazeMBRNBalance)}
                    />
                    <TxButton
                        marginTop={"3%"}
                        w="100%"
                        px="10"
                        isDisabled={!isGreaterThanZero(assetBidAmount) || bid?.simulate.isError || !bid?.simulate.data}
                        isLoading={bid.simulate.isPending && !bid.simulate.isError && bid.simulate.data}
                        onClick={() => bid.tx.mutate()}
                        chain_name="stargaze"
                    >
                        Bid
                    </TxButton>
                </Stack>
            </Card>
        </Stack>
    )
})

export default AssetAuction