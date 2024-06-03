import { Coin } from '@cosmjs/stargate'
import { getAssetByDenom } from '@/helpers/chain'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import { HStack, Stack, Text } from '@chakra-ui/react'
import { Liq } from './hooks/useLiquidations'

type SummaryItemProps = {
  id: string
  fee: number
}

const SummaryItem = ({id, fee}: SummaryItemProps) => (
  <HStack
    key={id}
    justifyContent="space-between"
    pb="1"
    my="1"
    borderBottom="1px solid"
    borderColor="whiteAlpha.200"
  >
    <Text variant="value" textTransform="unset">
         Liquidating position {id} with a ${fee} reward
    </Text>
  </HStack>
)

type Props = {
  liquidations: Liq[]
}

export const LiqSummary = ({ liquidations }: Props) => {
  return (
    <Stack h="max-content" overflow="auto" w="full">
      {liquidations
        .map((liq) => {
          return (
            <SummaryItem
            id={liq.position_id}
            fee={liq.position_fee}
            />
          )
        })}
    </Stack>
  )
}
