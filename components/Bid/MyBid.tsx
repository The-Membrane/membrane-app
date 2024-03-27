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

type MyBidItemProps = {
  label: string
}

const MyBidItem = ({ label }: MyBidItemProps) => {
  return (
    <HStack w="full">
      <Text variant="lable" w="full">
        {label}
      </Text>
      <Text variant="lable" w="full">
        10%
      </Text>

      <Slider aria-label="slider-ex-4" defaultValue={30}>
        <SliderTrack bg="#E2D8DA" h="2" borderRadius="80px">
          <SliderFilledTrack bg="#C445F0" />
        </SliderTrack>
        <SliderThumb boxSize={6} bg="#C445F0" cursor="grab" border="2px solid #E2D8DA" />
      </Slider>
    </HStack>
  )
}

const MyBid = () => {
  return (
    <Card w="470px" p="8" alignItems="center" gap={5}>
      <Text variant="title" fontSize="24px">
        My Bid
      </Text>
      {[10, 20, 30].map((i) => (
        <MyBidItem key={i} label={`${i} COT`} />
      ))}

      <Button>Confrim Bid</Button>
    </Card>
  )
}

export default MyBid
