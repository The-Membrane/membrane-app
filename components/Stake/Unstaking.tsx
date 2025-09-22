import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Stack, HStack, Image, Text, Box, VStack, useColorModeValue } from '@chakra-ui/react'
import React, { useEffect, useMemo } from 'react'
import useStaked from './hooks/useStaked'
import { TxButton } from '../TxButton'
import dayjs from 'dayjs'
import useClaimUnstake from './hooks/useClaimUnstake'
import useWallet from '@/hooks/useWallet'
import { colors } from '@/config/defaults'
import { useChainRoute } from '@/hooks/useChainRoute'

type Props = {}

export const getTimeLeft = (unstakeStartDate: number) => {
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

const DaysLeft = ({ unstakeStartDate }: { unstakeStartDate: number }) => {
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

const ClaimButton = ({ unstakeStartDate, action }: { unstakeStartDate: number, action: any }) => {
  const { minutesLeft } = getTimeLeft(unstakeStartDate)

  const isReadyToClaim = minutesLeft <= 0

  return (
    <TxButton
      w="fit-content"
      variant="ghost"
      size="sm"
      px="2"
      isLoading={action.simulate.isLoading || action.tx.isPending}
      isDisabled={action.simulate.isError || !isReadyToClaim}
      onClick={() => action.tx.mutate()}
    >
      Claim
    </TxButton>
  )
}

const Unstaking = (props: Props) => {
  const { chainName } = useChainRoute()
  const mbrn = useAssetBySymbol('MBRN', chainName)
  const { data } = useStaked(true)
  const { unstaking } = useMemo(() => data || { unstaking: [] }, [data])
  const { address } = useWallet(chainName)
  const { action: claim } = useClaimUnstake({ address: address, sim: true, run: true })
  const cardBg = useColorModeValue('#181F2A', '#232B3E')
  const borderColor = useColorModeValue('whiteAlpha.200', 'whiteAlpha.200')

  console.log("unstaking", data)

  if (!unstaking?.length)
    return (
      <Box bg={cardBg} borderRadius="xl" p={6} w="full" border="1px solid" borderColor={borderColor}>
        <HStack justifyContent="center" mt="5">
          <Text fontSize="sm" color={colors.noState}>
            You have no unstaking assets
          </Text>
        </HStack>
      </Box>
    )

  return (
    <Box bg={cardBg} borderRadius="xl" p={6} w="full" border="1px solid" borderColor={borderColor}>
      <VStack pt={2} gap={4} align="stretch">
        <HStack mb={3}>
          <Image src={mbrn?.logo} w="40px" h="40px" />
          <Text fontWeight="bold">{mbrn?.symbol}</Text>
        </HStack>
        {unstaking?.map((unstake: any, index: number) => (
          <HStack key={'unstake' + index} justifyContent="space-between" py={2} borderBottom={index !== unstaking.length - 1 ? '1px solid' : undefined} borderColor={borderColor}>
            <Text w="full">{shiftDigits(unstake?.amount || 0, -6).toString()}</Text>
            <DaysLeft unstakeStartDate={unstake?.unstake_start_time} />
            <ClaimButton unstakeStartDate={unstake?.unstake_start_time} action={claim} />
          </HStack>
        ))}
      </VStack>
    </Box>
  )
}

export default Unstaking
