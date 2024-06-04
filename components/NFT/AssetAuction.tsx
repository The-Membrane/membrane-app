import { Card, HStack, Text, Stack } from "@chakra-ui/react"
import { SliderWithState } from "../Mint/SliderWithState"
import { useAssetBySymbol } from "@/hooks/useAssets"
import { useBalanceByAsset } from "@/hooks/useBalance"
import useNFTState from "./hooks/useNFTState"
import { isGreaterThanZero, num } from "@/helpers/num"
import { TxButton } from "../TxButton"
import { useLiveAssetAuction, useLiveNFTAuction } from "./hooks/useBraneAuction"
import useCountdown from "@/hooks/useCountdown"
import useLiveAssetBid from "./hooks/useLiveAssetBid"
import { shiftDigits } from "@/helpers/math"
import { use, useEffect, useState } from "react"
import { Asset, getAssetBySymbol } from "@/helpers/chain"
import { useOraclePrice } from "@/hooks/useOracle"
import { Price } from "@/services/oracle"


const getMBRNPrice = (prices: Price[] | undefined, MBRN: Asset) => {
    console.log("MBRN asset", MBRN)
    const price = prices?.find((price) => price.denom === MBRN?.base)
    if (!price) return '0'
    return parseFloat((price.price)).toFixed(4)
}
const getCDTPrice = (prices: Price[] | undefined, cdt: Asset) => {
    console.log("CDT asset", cdt)
    const price = prices?.find((price) => price.denom === cdt?.base)
    if (!price) return '0'
    return parseFloat((price.price)).toFixed(4)
  }

const AssetAuction = () => {
    const { NFTState, setNFTState } = useNFTState()
    const bid = useLiveAssetBid()
    const { data: liveAssetAuction } = useLiveAssetAuction()
    const auctionAmount = liveAssetAuction?.auctioned_asset.amount
    const currentBid = liveAssetAuction?.highest_bid.amount
    const { data: liveNFTAuction } = useLiveNFTAuction()
    //Bid Auctions end when the current NFT auction does
    const timeLeft = useCountdown(liveNFTAuction?.auction_end_time).timeString

    const stargazeMBRN = useAssetBySymbol('MBRN', 'stargaze')
    const stargazeMBRNBalance = useBalanceByAsset(stargazeMBRN, 'stargaze')
        
    const { data: prices } = useOraclePrice()
    const cdt = getAssetBySymbol('CDT')
    const MBRN = getAssetBySymbol('MBRN')        
    const [cdtPrice, setcdtPrice ] = useState('0')
    const [mbrnPrice, setmbrnPrice ] = useState('0')
    useEffect(() => {      
        const CDTprice = getCDTPrice(prices, cdt!)
        if (CDTprice != cdtPrice && CDTprice != '0') setcdtPrice(CDTprice)
            
        const MBRNprice = getMBRNPrice(prices, MBRN!)
        if (MBRNprice != mbrnPrice && MBRNprice != '0') setmbrnPrice(MBRNprice)
        console.log("Prices:", cdtPrice, mbrnPrice, "fn prices:", MBRNprice, CDTprice)

    }, [prices, cdt, MBRN])

    const onBidChange = (value: number) => {
        setNFTState({ assetBidAmount: value })
    }

    if (!liveAssetAuction) return null

    return (
        <Stack w="full" gap="5">
        <Text variant="title">ASSET AUCTION</Text>
        <Card w="full" p="8" marginTop={"5.1%"} alignItems="center" gap={5} h="28%" justifyContent="space-between">            
            <Stack w="full" gap="1">
                <Text fontSize="16px" fontWeight="700">                    
                Auction for {shiftDigits(auctionAmount??0, -6).toString()} CDT —— equivalent to {num(cdtPrice).dividedBy(num(mbrnPrice)).toString()} MBRN
                </Text>
                <Text fontSize="16px" fontWeight="700">
                Current Bid: {shiftDigits(currentBid??0, -6).toString()} MBRN
                </Text>
                <Text fontSize="16px" fontWeight="700">
                Time Left: {timeLeft}
                </Text>
                <HStack justifyContent="space-between">
                    <Text fontSize="16px" fontWeight="700">
                    MBRN
                    </Text>
                    <Text fontSize="16px" fontWeight="700">
                    {NFTState.assetBidAmount}
                    </Text>
                </HStack>
                <SliderWithState
                    value={NFTState.assetBidAmount}
                    onChange={onBidChange}
                    min={0}
                    max={Number(stargazeMBRNBalance)}
                />
                <TxButton
                    marginTop={"3%"}
                    w="100%"
                    px="10"
                    isDisabled={!isGreaterThanZero(NFTState.assetBidAmount) || bid?.simulate.isError || !bid?.simulate.data}
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
}

export default AssetAuction