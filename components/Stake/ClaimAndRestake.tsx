import { TxButton } from '@/components/TxButton'
import { shiftDigits } from '@/helpers/math'
import { isGreaterThanZero, num } from '@/helpers/num'
import { HStack, Image, Stack, Text } from '@chakra-ui/react'
import { useMemo } from 'react'
import useStakingClaim from './hooks/useStakingClaim'
import useStaked from './hooks/useStaked'
import { useAssetBySymbol } from '@/hooks/useAssets'

type Props = {}

const RestakeButton = ({ reward }: any) => {
  const claim = useStakingClaim(true).action

  return (
    <TxButton
      variant="ghost"
      size="sm"
      px="2"
      isDisabled={Number(reward) <= 0}
      isLoading={claim.simulate.isLoading || claim.tx.isPending}      
      onClick={() => claim.tx.mutate()}
    >
      Restake
    </TxButton>
  )
}

const ClaimAndRestake = (props: Props) => {
  const { data } = useStaked()
  const { rewards = [] } = data || {}
  const claim = useStakingClaim().action

  const CDT = useAssetBySymbol('CDT')
  const MBRN = useAssetBySymbol('MBRN')

  //MBRN claims
  const mbrnClaims = rewards.reduce((acc, reward) => {
    if (reward?.asset?.symbol === 'MBRN') {
      return acc.plus(reward?.amount)
    }
    return acc
  }, num(0))

  ///CDT claims
  const cdtClaims = rewards.reduce((acc, reward) => {
    if (reward?.asset?.symbol === 'CDT') {
      return acc.plus(reward?.amount)
    }
    return acc
  }, num(0))
  

  if (!rewards.length)
    return (
      <HStack justifyContent="center" mt="5">
        <Text fontSize="sm" color="gray">
          You have no claimable rewards
        </Text>
      </HStack>
    )

  return (
    <Stack gap="10" pt="5">
      <Stack>
        {/* MBRN Claim */}
          <HStack justifyContent="space-between">
            <HStack>
              <Image
                src={MBRN?.logo}
                w="20px"
                h="20px"
                transform={'scale(1.2)'}
              />
              <Text>{MBRN?.symbol}</Text>
            </HStack>
            <HStack>
              <Text>{shiftDigits(mbrnClaims.toNumber(), -6).toString()}</Text>
              <RestakeButton reward={mbrnClaims} />
            </HStack>
          </HStack>
          {/* CDT Claim */}
          <HStack justifyContent="space-between">
            <HStack>
              <Image
                src={CDT?.logo}
                w="20px"
                h="20px"
                transform={'none'}
              />
              <Text>{CDT?.symbol}</Text>
            </HStack>
            <HStack>
              <Text>{shiftDigits(cdtClaims.toNumber(), -6).toString()}</Text>
            </HStack>
          </HStack>
      </Stack>
      <TxButton
        isDisabled={!isGreaterThanZero(cdtClaims.toNumber()) && !isGreaterThanZero(mbrnClaims.toNumber())}
        isLoading={claim.simulate.isLoading || claim.tx.isPending}
        onClick={() => claim.tx.mutate()}
      >
        Claim
      </TxButton>
    </Stack>
  )
}

