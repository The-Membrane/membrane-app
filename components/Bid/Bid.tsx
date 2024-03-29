import { HStack, Stack } from '@chakra-ui/react'
import MyBid from './MyBid'
import PlaceBid from './PlaceBid'
import Risk from './Risk'
import Filtration from './Filtration'
import BidAction from './BidAction'

const Bid = () => {
  return (
    <HStack spacing="5" alignItems="flex-start">
      <Stack gap="5" minW="500px">
        <Risk />
        <BidAction />
      </Stack>
      <Filtration />
    </HStack>
  )
}

export default Bid
