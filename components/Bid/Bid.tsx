import { HStack, Stack } from '@chakra-ui/react'
import BidAction from './BidAction'
import Filtration from './Filtration'
import Risk from './Risk'

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
