import { HStack, Stack } from '@chakra-ui/react'
import MyBid from './MyBid'
import PlaceBid from './PlaceBid'
import Risk from './Risk'
import Filtration from './Filtration'

const Bid = () => {
  return (
    <HStack spacing="5" alignItems="flex-start">
      <Stack gap="5">
        <Risk />
        <PlaceBid />
        <MyBid />
      </Stack>
      <Filtration />
    </HStack>
  )
}

export default Bid
