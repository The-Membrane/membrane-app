import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Stack, HStack, Image, Text } from '@chakra-ui/react'
import React from 'react'
import useStaked from './hooks/useStaked'
import { TxButton } from '../TxButton'
import dayjs from 'dayjs'

type Props = {}

const DaysLeft = ({ unstakeStartDate }) => {
  const unstakingDate = dayjs.unix(unstakeStartDate).add(4, 'day')
  const daysLeft = unstakingDate.diff(dayjs(), 'day')
  const hoursLeft = unstakingDate.diff(dayjs(), 'hour')
  const minutesLeft = unstakingDate.diff(dayjs(), 'minute')

  if (daysLeft <= 0 && hoursLeft <= 0) {
    return <Text> claim in {minutesLeft} minutes</Text>
  } else if (daysLeft <= 0 && hoursLeft > 0) {
    return <Text>claim in {hoursLeft} hours</Text>
  } else {
    return (
      <Text>
        claim in {daysLeft + 1} {daysLeft === 1 ? 'day' : 'days'}
      </Text>
    )
  }
}

const Unstaking = (props: Props) => {
  const mbrn = useAssetBySymbol('MBRN')
  const { data } = useStaked()
  const { unstaking } = data || {}

  return (
    <Stack pt="5" gap="0">
      <HStack mb="3">
        <Image src={mbrn?.logo} w="40px" h="40px" />
        <Text>{mbrn?.symbol}</Text>
      </HStack>
      {unstaking?.map((unstake) => (
        <HStack justifyContent="space-between">
          <Text>{shiftDigits(unstake?.amount || 0, -6).toString()}</Text>
          <DaysLeft unstakeStartDate={unstake?.unstake_start_time} />

          <TxButton w="fit-content" variant="ghost" size="sm" px="2">
            Claim
          </TxButton>
        </HStack>
      ))}
    </Stack>
  )
}

export default Unstaking
