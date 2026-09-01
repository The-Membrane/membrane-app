import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Stack, HStack, Image, Text, Box, VStack } from '@chakra-ui/react'
import React, { useEffect, useMemo } from 'react'
import useStaked from './hooks/useStaked'
import { TxButton } from '../TxButton'
import useClaimUnstake from './hooks/useClaimUnstake'
import useWallet from '@/hooks/useWallet'
import { useChainRoute } from '@/hooks/useChainRoute'
import { getTimeLeft } from './unstakingUtils'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'

type Props = {}

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
      px={SPACING.sm}
      _focus={FOCUS_STYLES.ring}
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

  console.log("unstaking", data)

  if (!unstaking?.length)
    return (
      <Box bg={SEMANTIC_COLORS.bgSecondary} borderRadius={0} p={SPACING.lg} w="full" border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
        <HStack justifyContent="center" mt={SPACING.lg}>
          <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary}>
            You have no unstaking assets
          </Text>
        </HStack>
      </Box>
    )

  return (
    <Box bg={SEMANTIC_COLORS.bgSecondary} borderRadius={0} p={SPACING.lg} w="full" border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
      <VStack pt={SPACING.sm} gap={SPACING.base} align="stretch">
        <HStack mb={SPACING.md}>
          <Image src={mbrn?.logo} w="40px" h="40px" />
          <Text fontWeight={TYPOGRAPHY.bold}>{mbrn?.symbol}</Text>
        </HStack>
        {unstaking?.map((unstake: any, index: number) => (
          <HStack key={'unstake' + index} justifyContent="space-between" py={SPACING.sm} borderBottom={index !== unstaking.length - 1 ? '1px solid' : undefined} borderColor={SEMANTIC_COLORS.borderSubtle}>
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
