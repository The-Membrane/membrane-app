
import React, { useMemo } from "react"
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { TxButton } from "../TxButton"
import { isGreaterThanZero } from "@/helpers/num"
import useAuction, { useLiveFeeAuction } from "./hooks/useAuction"
import dayjs from "dayjs"
import ConfirmModal from "../ConfirmModal"
import { SPACING } from "@/config/spacing"
import { FOCUS_STYLES } from "@/config/transitions"

const auctionDiscount = 0.01
const auctionDiscountIncreaseTimeframe = 36

const AuctionClaim = React.memo(function AuctionClaim() {
  // Auction.sol pulls CDT as the quote asset (AUC-C-01) — gate on CDT, not MBRN
  const cdt = useAssetBySymbol('CDT')
  const CDTBalance = useBalanceByAsset(cdt)
  const { action: claim } = useAuction()
  const { data: feeAuctions } = useLiveFeeAuction()

  //Take the lowest discount
  const discount = useMemo(() => {
    if (!feeAuctions || !feeAuctions[0]) return 0
    const startTime = dayjs.unix(Number(feeAuctions[0].auctionStartTime))
    const currentTime = dayjs()
    const timeElapsed = startTime.diff(currentTime, 'second')
    const discount = parseInt((timeElapsed / auctionDiscountIncreaseTimeframe).toFixed(0)) * auctionDiscount

    return Math.max(discount, 0.99) * 100
  }, [feeAuctions])
  return (
    // <ConfirmModal 
    //     action={claim}
    //     label={`${discount}% Discount on Fee Auction`}
    //     isDisabled={!isGreaterThanZero(MBRNBalance) }>
          
    //       {/* <QASummary newPositionValue={parseInt(newPositionValue.toFixed(0))} swapRatio={swapRatio} summary={summary}/> */}
    //     </ConfirmModal>
      <TxButton
        // marginTop={"3%"}
        w="full"
        height="64px"
        px={SPACING.xl}
        _focus={FOCUS_STYLES.ring}
        isDisabled={!isGreaterThanZero(CDTBalance) || claim?.simulate.isError || !claim?.simulate.data}
        isLoading={claim.simulate.isPending && !claim.simulate.isError && claim.simulate.data}
        onClick={() => claim.tx.mutate()}
        toggleConnectLabel={false}
        >
        {discount}% Discount on Fee Auction
    </TxButton>
  )
})

export default AuctionClaim
