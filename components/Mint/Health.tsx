import { Box, Text } from '@chakra-ui/react'
import React from 'react'
import { useCurrentPosition } from './hooks/useCurrentPosition'
import useVaultSummary from './hooks/useVaultSummary'
import { num } from '@/helpers/num'

type Props = {}

const Health = (props: Props) => {
  const { ltv, liqudationLTV } = useVaultSummary()

  var health = num(1).minus(num(ltv).dividedBy(liqudationLTV)).times(100).dp(0).toNumber()
  if (health < 0) health = 0

  return (
    <Box position="absolute" bottom="214px" left="110px">
      <Text fontSize="20px" fontWeight="bold" color="black">
        Health : {health}%
      </Text>
    </Box>
  )
}

export default Health
