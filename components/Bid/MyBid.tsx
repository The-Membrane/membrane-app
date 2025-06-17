import { Bid, BidResponse } from '@/contracts/codegen/liquidation_queue/LiquidationQueue.types'
import { shiftDigits } from '@/helpers/math'
import {
  Button,
  Card,
  HStack,
  Slider,
  SliderFilledTrack,
  SliderThumb,
  SliderTrack,
  Text,
  useColorModeValue,
} from '@chakra-ui/react'
import { GrPowerReset } from 'react-icons/gr'
import ConfirmModal from '../ConfirmModal'
import UpdateBidSummary from './UpdateBidSummary'
import useBidState from './hooks/useBidState'
import useUpdateBid from './hooks/useUpdateBid'
import { colors } from '@/config/defaults'
import { useUserBids } from '@/hooks/useLiquidations'

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
      <Text variant="lable" mr="3">
        {bid?.liq_premium}%
      </Text>

      <Text variant="lable" w="full" textAlign="end" mr="3">
        {value} CDT
      </Text>

      <Slider
        w="full"
        aria-label="slider-ex-4"
        defaultValue={0}
        value={value}
        max={bidAmount}
        onChange={onCDTChange}
      >
        <SliderTrack bg="#E2D8DA" h="2" borderRadius="80px">
          <SliderFilledTrack bg="#C445F0" />
        </SliderTrack>
        <SliderThumb boxSize={6} bg="#C445F0" cursor="grab" border="2px solid #E2D8DA" />
      </Slider>
    </HStack>
  )
}

const MyBid = () => {
  const { data } = useUserBids()
  const bids = data ?? []
  const { setBidState, bidState } = useBidState()
  const cardBg = useColorModeValue('#181F2A', '#232B3E')

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
      <Card p={8} alignItems="center" gap={8} borderRadius="2xl" boxShadow="lg" w="full" bg={cardBg}>
        <Text variant="title" fontSize="2xl" fontWeight="bold" textAlign="center" color="white">
          My {bidState?.selectedAsset?.symbol ?? ""} Bids
        </Text>
        <Text color={colors.noState}>No active bids</Text>
      </Card>
    )
  }
  return (
    <Card p={8} alignItems="center" gap={8} borderRadius="2xl" boxShadow="lg" w="full" bg={cardBg}>
      <Text variant="title" fontSize="2xl" fontWeight="bold" textAlign="center" color="white">
        My {bidState?.selectedAsset?.symbol ?? ""} Bids
      </Text>
      {bids?.map((bid) => <MyBidItem key={bid?.id} bid={bid} />)}
      <HStack w="full" mt={4} justifyContent="flex-end">
        <Button variant="ghost" leftIcon={<GrPowerReset />} onClick={onRest}>
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
