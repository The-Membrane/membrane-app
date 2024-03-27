import React from 'react'
import Card from '@/components/Card'
import { Text } from '@chakra-ui/react'

type Props = {}

const YourRate = (props: Props) => {
  return (
    <Card maxW="300px">
      <Text variant="title" fontSize="24px">
        Your Rate
      </Text>
    </Card>
  )
}

export default YourRate
