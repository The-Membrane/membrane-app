import { num } from '@/helpers/num'
import { Box, Text } from '@chakra-ui/react'
import { useMemo } from 'react'
import useVaultSummary from './hooks/useVaultSummary'

type Props = {}

const Health = (props: Props) => {
  const { ltv, liqudationLTV } = useVaultSummary()

  const health = useMemo(() => {
    if (ltv === 0) return 100
    console.log(ltv, liqudationLTV)
    return num(1).minus(num(ltv).dividedBy(liqudationLTV)).times(100).dp(0).toNumber()
  }, [ltv, liqudationLTV])

  return (
    <Box position="absolute" bottom="214px" left="110px">
      <Text fontSize="20px" fontWeight="bold" color="black">
        Health : {Math.min(health, 100)}%
      </Text>
    </Box>
  )
}

export default Health
