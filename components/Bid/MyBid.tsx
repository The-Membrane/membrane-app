import {
  Button,
  Card,
  HStack,
  Slider,
  SliderFilledTrack,
  SliderThumb,
  SliderTrack,
  Text,
} from '@chakra-ui/react'
import useUserBids from './hooks/useUserBids'
import { shiftDigits } from '@/helpers/math'
import { BidResponse } from '@/contracts/codegen/liquidation_queue/LiquidationQueue.types'
import useBidState from './hooks/useBidState'
import { GrPowerReset } from 'react-icons/gr'
import ConfirmModal from '../ConfirmModal'
import useUpdateBid from './hooks/useUpdateBid'
import TxError from '../TxError'
import UpdateBidSummary from './UpdateBidSummary'

type MyBidItemProps = {
  bid: BidResponse
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
  const { data: bids = [] } = useUserBids()
  const { setBidState } = useBidState()

  const txSuccess = () => {
    setBidState({ placeBid: { cdt: 0, premium: 0 }, updateBids: [] })
  }
  const updateBid = useUpdateBid({ txSuccess })

  const onRest = () => {
    setBidState({
      updateBids: [],
    })
  }

  if (bids.length === 0) {
    return (
      <Card p="8" alignItems="center" gap={5}>
        <Text variant="title" fontSize="24px">
          My Bid
        </Text>
        <Text color="gray">No active bids</Text>
      </Card>
    )
  }
  return (
    <Card p="8" alignItems="center" gap={5}>
      <Text variant="title" fontSize="24px">
        My Bid
      </Text>

      {bids?.map((bid) => <MyBidItem key={bid?.id} bid={bid} />)}

      <HStack w="full" mt="4">
        <Button variant="ghost" leftIcon={<GrPowerReset />} onClick={onRest}>
          Reset
        </Button>

        {/* <Button>Confrim Bid</Button> */}
        <ConfirmModal label="Confirm Bid" action={updateBid}>
          <UpdateBidSummary />
          <TxError action={updateBid} />
        </ConfirmModal>
      </HStack>
      <TxError action={updateBid} />
    </Card>
  )
}

export default MyBid
