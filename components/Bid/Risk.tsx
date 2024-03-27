import React from 'react'
import RiskChart from './RiskChart'
import { Card, Text } from '@chakra-ui/react'

const Risk = () => {
  return (
    <Card w="470px" p="8" alignItems="center" gap={5}>
      <Text variant="title">risky TVL in</Text>

      <RiskChart />
    </Card>
  )
}

export default Risk
