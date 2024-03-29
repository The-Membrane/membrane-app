import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Stack, HStack, Image, Text } from '@chakra-ui/react'
import React from 'react'
import useStaked from './hooks/useStaked'
import { TxButton } from '../TxButton'
import dayjs from 'dayjs'
import useClaimUnstake from './hooks/useClaimUnstake'

type Props = {}

const getTimeLeft = (unstakeStartDate) => {
  const unstakingDate = dayjs.unix(unstakeStartDate).add(4, 'day')
  const daysLeft = unstakingDate.diff(dayjs(), 'day')
  const hoursLeft = unstakingDate.diff(dayjs(), 'hour')
  const minutesLeft = unstakingDate.diff(dayjs(), 'minute')

  return {
    daysLeft,
    hoursLeft,
    minutesLeft,
  }
}

const DaysLeft = ({ unstakeStartDate }) => {
  const { daysLeft, hoursLeft, minutesLeft } = getTimeLeft(unstakeStartDate)

  if (minutesLeft <= 0) {
    return null
  } else if (daysLeft <= 0 && hoursLeft <= 0) {
    return <Text w="full"> claim in {minutesLeft} minutes</Text>
  } else if (daysLeft <= 0 && hoursLeft > 0) {
    return <Text w="full">claim in {hoursLeft} hours</Text>
  } else {
    return (
      <Text w="full">
        claim in {daysLeft + 1} {daysLeft === 1 ? 'day' : 'days'}
      </Text>
    )
  }
}

const ClaimButton = ({ unstakeStartDate }) => {
  const { minutesLeft } = getTimeLeft(unstakeStartDate)
  const claim = useClaimUnstake()

  const isReadyToClaim = minutesLeft <= 0

  return (
    <TxButton
      w="fit-content"
      variant="ghost"
      size="sm"
      px="2"
      isLoading={claim.isPending}
      isDisabled={!isReadyToClaim}
      onClick={() => claim.mutate()}
    >
      Claim
    </TxButton>
  )
}

const Unstaking = (props: Props) => {
  const mbrn = useAssetBySymbol('MBRN')
  const { data } = useStaked()
  const { unstaking = [] } = data || {}

  if (!unstaking?.length)
    return (
      <HStack justifyContent="center" mt="5">
        <Text fontSize="sm" color="gray">
          You have no unstaking assets
        </Text>
      </HStack>
    )

  return (
    <Stack pt="5" gap="0">
      <HStack mb="3">
        <Image src={mbrn?.logo} w="40px" h="40px" />
        <Text>{mbrn?.symbol}</Text>
      </HStack>
      {unstaking?.map((unstake, index) => (
        <HStack key={'unstake' + index} justifyContent="space-between">
          <Text w="full">{shiftDigits(unstake?.amount || 0, -6).toString()}</Text>
          <DaysLeft unstakeStartDate={unstake?.unstake_start_time} />

          <ClaimButton unstakeStartDate={unstake?.unstake_start_time} />
        </HStack>
      ))}
    </Stack>
  )
}

export default Unstaking
