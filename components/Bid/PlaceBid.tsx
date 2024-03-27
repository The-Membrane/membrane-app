import { Card, FormControl, FormLabel, Input, Text } from '@chakra-ui/react'

type BidInputProps = {
  label: string
}

const BidInput = ({ label }: BidInputProps) => {
  return (
    <FormControl
      display="flex"
      justifyContent="space-between"
      gap={2}
      w="310px"
      alignItems="center"
    >
      <Input type="number" placeholder="0.00" />
      <FormLabel fontSize="24px" fontWeight="700" w="full">
        {label}{' '}
      </FormLabel>
    </FormControl>
  )
}

const PlaceBid = () => {
  return (
    <Card w="470px" p="8" alignItems="center" gap={5}>
      <Text variant="title" fontSize="24px">
        Place Bid
      </Text>

      <BidInput label="COT with" />
      <BidInput label="% Premium" />
    </Card>
  )
}

export default PlaceBid
