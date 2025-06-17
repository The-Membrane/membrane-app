import { TxButton } from '@/components/TxButton'
import { shiftDigits } from '@/helpers/math'
import { isGreaterThanZero, num } from '@/helpers/num'
import { HStack, Image, Stack, Text, Box, VStack, useColorModeValue } from '@chakra-ui/react'
import { useMemo } from 'react'
import useStakingClaim from './hooks/useStakingClaim'
import useStaked from './hooks/useStaked'
import { useAssetBySymbol } from '@/hooks/useAssets'

type Props = {}

const RestakeButton = (reward: any) => {
  const { action: claim } = useStakingClaim(true)

  return (
    <TxButton
      variant="ghost"
      size="sm"
      px="2"
      isDisabled={Number(reward) <= 0}
      isLoading={claim?.simulate.isLoading || claim?.tx.isPending}
      onClick={() => claim?.tx.mutate()}
    >
      Restake
    </TxButton>
  )
}

export const ClaimAndRestake = (props: Props) => {
  const { data } = useStaked(true)
  const { rewards = [] } = data || {}
  const { action: claim } = useStakingClaim(false)
  console.log("CLAIM", claim)

  const CDT = useAssetBySymbol('CDT')
  const MBRN = useAssetBySymbol('MBRN')

  //MBRN claims
  const mbrnClaims = useMemo(() => {
    const reward = rewards.reduce((acc, reward) => {
      if (reward?.asset?.symbol === 'MBRN') {
        return acc.plus(reward?.amount)
      }
      return acc.plus(0)
    }, num(0))

    return reward
  }, [rewards])

  ///CDT claims
  const cdtClaims = useMemo(() => {
    const reward = rewards.reduce((acc, reward) => {
      if (reward?.asset?.symbol === 'CDT') {
        return acc.plus(reward?.amount)
      }
      return acc.plus(0)
    }, num(0))

    return reward
  }, [rewards])

  const cardBg = useColorModeValue('#181F2A', '#232B3E')
  const borderColor = useColorModeValue('whiteAlpha.200', 'whiteAlpha.200')

  if (!rewards.length)
    return (
      <Box bg={cardBg} borderRadius="xl" p={6} w="full" border="1px solid" borderColor={borderColor}>
        <HStack justifyContent="center" mt="5">
          <Text fontSize="sm" color="gray">
            You have no claimable rewards
          </Text>
        </HStack>
      </Box>
    )

  return (
    <Box bg={cardBg} borderRadius="xl" p={6} w="full" border="1px solid" borderColor={borderColor}>
      <VStack gap={8} align="stretch">
        <VStack gap={4} align="stretch">
          {/* MBRN Claim */}
          {MBRN && mbrnClaims > num(1) && (
            <HStack justifyContent="space-between">
              <HStack>
                <Image src={MBRN.logo} w="20px" h="20px" transform={'scale(1.2)'} />
                <Text fontWeight="bold">{MBRN.symbol}</Text>
              </HStack>
              <HStack>
                <Text>{shiftDigits(mbrnClaims.toNumber(), -6).toString()}</Text>
                <RestakeButton reward={mbrnClaims} />
              </HStack>
            </HStack>
          )}
          {/* CDT Claim */}
          {CDT && cdtClaims > num(1) && (
            <HStack justifyContent="space-between">
              <HStack>
                <Image src={CDT.logo} w="20px" h="20px" transform={'none'} />
                <Text fontWeight="bold">{CDT.symbol}</Text>
              </HStack>
              <HStack>
                <Text>{shiftDigits(cdtClaims.toNumber(), -6).toString()}</Text>
              </HStack>
            </HStack>
          )}
        </VStack>
        <HStack justifyContent="flex-end">
          <TxButton
            isDisabled={!isGreaterThanZero(cdtClaims.toNumber()) && !isGreaterThanZero(mbrnClaims.toNumber())}
            isLoading={claim?.simulate.isLoading || claim?.tx.isPending}
            onClick={() => claim?.tx.mutate()}
          >
            Claim
          </TxButton>
        </HStack>
      </VStack>
    </Box>
  )
}

export default ClaimAndRestake