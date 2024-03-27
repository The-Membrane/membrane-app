import { Stack } from '@chakra-ui/react'
import MyBid from './MyBid'
import PlaceBid from './PlaceBid'
import Risk from './Risk'

const Bid = () => {
  return (
    <Stack pb="10">
      <Risk />
      <PlaceBid />
      <MyBid />
    </Stack>
  )
}

export default Bid
