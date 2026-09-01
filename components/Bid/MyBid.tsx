import { Bid, BidResponse } from '@/contracts/codegen/liquidation_queue/LiquidationQueue.types'
import { shiftDigits } from '@/helpers/math'
import {
  Button,
  HStack,
  Slider,
  SliderFilledTrack,
  SliderThumb,
  SliderTrack,
  Text,
} from '@chakra-ui/react'
import { Card } from '@/components/ui/Card'
import { GrPowerReset } from 'react-icons/gr'
import ConfirmModal from '../ConfirmModal'
import UpdateBidSummary from './UpdateBidSummary'
import useBidState from './hooks/useBidState'
import useUpdateBid from './hooks/useUpdateBid'
import { useUserBids } from '@/hooks/useLiquidations'
import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'

type MyBidItemProps = {
  bid: Bid
}

const MyBidItem = ({ bid }: MyBidItemProps) => {
  const { bidState, setBidState } = useBidState()
  const { updateBids = [] } = bidState
  const existingBid = updateBids.find((b) => b.id === bid.id) || bid

  const onCDTChange = (value: number) => {
    const newBid = {
      ...existingBid,
      newAmount: value,
    }

    const newBids = updateBids.map((b) => {
      if (b.id === bid.id) {
        return newBid
      }
      return b
    })

    if (newBids.length === 0) {
      newBids.push(newBid)
    }

    setBidState({
      ...bidState,
      updateBids: newBids,
    })
  }

  const bidAmount = shiftDigits(bid.amount, -6).toNumber()
  const value = 'newAmount' in existingBid ? Number(existingBid?.newAmount) : bidAmount

  return (
    <HStack w="full">
      <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary} mr={SPACING.md}>
        {bid?.liq_premium}%
      </Text>

      <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary} w="full" textAlign="end" mr={SPACING.md}>
        {value} CDT
      </Text>

      <Slider
        w="full"
        aria-label="Adjust bid amount"
        defaultValue={0}
        value={value}
        max={bidAmount}
        onChange={onCDTChange}
      >
        <SliderTrack bg={SEMANTIC_COLORS.borderStrong} h="2" borderRadius="80px">
          <SliderFilledTrack bg={SEMANTIC_COLORS.primary} />
        </SliderTrack>
        <SliderThumb
          boxSize={6}
          bg={SEMANTIC_COLORS.primary}
          cursor="grab"
          border="2px solid"
          borderColor={SEMANTIC_COLORS.borderStrong}
        />
      </Slider>
    </HStack>
  )
}

const MyBid = () => {
  const { data } = useUserBids()
  const bids = data ?? []
  const { setBidState, bidState } = useBidState()

  const txSuccess = () => {
    setBidState({ placeBid: { cdt: 0, premium: 0 }, updateBids: [] })
  }
  const updateBid = useUpdateBid({ txSuccess })

  const onRest = () => {
    setBidState({
      updateBids: [],
    })
  }

  const isDisabled = !bidState?.updateBids?.length

  if (bids.length === 0) {
    return (
      <Card variant="default" display="flex" flexDirection="column" alignItems="center" gap={SPACING.lg} w="full">
        <Text fontSize={TYPOGRAPHY.h2} fontWeight={TYPOGRAPHY.bold} textAlign="center" color={SEMANTIC_COLORS.textPrimary}>
          My {bidState?.selectedAsset?.symbol ?? ""} Bids
        </Text>
        <Text color={SEMANTIC_COLORS.textTertiary}>No active bids</Text>
      </Card>
    )
  }
  return (
    <Card variant="default" display="flex" flexDirection="column" alignItems="center" gap={SPACING.lg} w="full">
      <Text fontSize={TYPOGRAPHY.h2} fontWeight={TYPOGRAPHY.bold} textAlign="center" color={SEMANTIC_COLORS.textPrimary}>
        My {bidState?.selectedAsset?.symbol ?? ""} Bids
      </Text>
      {bids?.map((bid) => <MyBidItem key={bid?.id} bid={bid} />)}
      <HStack w="full" mt={SPACING.base} justifyContent="flex-end">
        <Button
          variant="ghost"
          leftIcon={<GrPowerReset />}
          onClick={onRest}
          transition={TRANSITIONS.all}
          _hover={HOVER_EFFECTS.borderHighlight}
          _focus={FOCUS_STYLES.ring}
        >
          Reset
        </Button>
        <ConfirmModal label="Update Bid" action={updateBid} isDisabled={isDisabled}>
          <UpdateBidSummary />
        </ConfirmModal>
      </HStack>
    </Card>
  )
}

export default MyBid
