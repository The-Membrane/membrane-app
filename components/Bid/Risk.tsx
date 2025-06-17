import React from 'react'
import RiskChart from './RiskChart'
import { Card, Text, useColorModeValue } from '@chakra-ui/react'

import SelectAsset from './SelectAsset'

const Risk = () => {
  const cardBg = useColorModeValue('#181F2A', '#232B3E')
  return (
    <Card p={8} alignItems="center" gap={5} borderRadius="2xl" boxShadow="lg" bg={cardBg} w="full">
      <Text variant="title" color="white">Liquidation TVL For</Text>

      <SelectAsset />

      <RiskChart />
    </Card>
  )
}

export default Risk
