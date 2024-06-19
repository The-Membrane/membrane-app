
import React, { useMemo } from "react"
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { TxButton } from "../TxButton"
import { isGreaterThanZero } from "@/helpers/num"
import useAuction, { useLiveFeeAuction } from "./hooks/useAuction"
import dayjs from "dayjs"

const auctionDiscount = 0.01
const auctionDiscountIncreaseTimeframe = 36

const Stake = React.memo(() => {
  const mbrn = useAssetBySymbol('MBRN')
  const MBRNBalance = useBalanceByAsset(mbrn)
  const { action: claim } = useAuction()
  const { data: feeAuctions } = useLiveFeeAuction()

  //Take the lowest discount
  const discount = useMemo(() => {
    if (!feeAuctions) return 0
    const startTime = dayjs.unix(feeAuctions[0].auction_start_time)
    const currentTime = dayjs()
    const timeElapsed = startTime.diff(currentTime, 'second')
    const discount = parseInt((timeElapsed / auctionDiscountIncreaseTimeframe).toFixed(0)) * auctionDiscount

    return Math.max(discount, 1)
  }, [feeAuctions])
  
  return (
    <TxButton
        // marginTop={"3%"}
        w="full"
        height="64px"
        borderRadius="50%"
        px="10"
        isDisabled={!isGreaterThanZero(MBRNBalance) || claim?.simulate.isError || !claim?.simulate.data}
        isLoading={claim.simulate.isPending && !claim.simulate.isError && claim.simulate.data}
        onClick={() => claim.tx.mutate()}
        toggleConnectLabel={false}
        >
        {discount}% Discount on Fee Auction
    </TxButton>
  )
})

export default Stake
