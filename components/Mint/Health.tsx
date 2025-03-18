import { num } from '@/helpers/num'
import { Box, Text } from '@chakra-ui/react'
import { useMemo } from 'react'
import useVaultSummary from './hooks/useVaultSummary'

type Props = {}

const Health = (props: Props) => {
  const { data } = useVaultSummary()
  const { ltv, liqudationLTV } = data || {
    debtAmount: 0,
    cost: 0,
    tvl: 0,
    ltv: 0,
    borrowLTV: 0,
    liquidValue: 0,
    liqudationLTV: 0,
  }

  const health = useMemo(() => {
    if (ltv === 0) return 100
    return num(1).minus(num(ltv).dividedBy(liqudationLTV)).times(100).dp(0).toNumber()
  }, [ltv, liqudationLTV])

  return (
    <Box position="absolute" bottom="214px" left="110px">
      <Text fontSize="20px" fontWeight="bold" color="black">
        Health : {`${Math.min(Math.max(0, health), 100)}%`}
      </Text>
    </Box>
  )
}

export default Health
