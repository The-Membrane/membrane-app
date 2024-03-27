import { Stack } from '@chakra-ui/react'
import MyBid from './MyBid'
import PlaceBid from './PlaceBid'
import Risk from './Risk'
import Filtration from './Filtration'

const Bid = () => {
  return (
    <Stack gap="5">
      <Risk />
      <PlaceBid />
      <MyBid />
      <Filtration />
    </Stack>
  )
}

export default Bid
