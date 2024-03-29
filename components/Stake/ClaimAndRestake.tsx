import { TxButton } from '@/components/TxButton'
import { shiftDigits } from '@/helpers/math'
import { isGreaterThanZero, num } from '@/helpers/num'
import { HStack, Image, Stack, Text } from '@chakra-ui/react'
import { useMemo } from 'react'
import useClaim from './hooks/useClaim'
import useStaked from './hooks/useStaked'

type Props = {}

const RestakeButton = ({ reward }: any) => {
  const claim = useClaim(true)

  if (reward?.asset?.symbol !== 'MBRN') return null

  return (
    <TxButton
      variant="ghost"
      size="sm"
      px="2"
      isDisabled={Number(reward?.amount) <= 0}
      isLoading={claim.isPending}
      onClick={() => claim.mutate()}
    >
      Restake
    </TxButton>
  )
}

const ClaimAndRestake = (props: Props) => {
  const { data } = useStaked()
  const { rewards = [] } = data || {}
  const claim = useClaim()

  const claimable = useMemo(() => {
    const rewardsAmount = rewards.reduce((acc, reward) => {
      return acc.plus(reward?.amount)
    }, num(0))

    return shiftDigits(rewardsAmount.toNumber(), -6).toString()
  }, [rewards])

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
        {rewards.map((reward, index) => (
          <HStack justifyContent="space-between" key={reward?.asset?.base}>
            <HStack>
              <Image
                src={reward?.asset?.logo}
                w="20px"
                h="20px"
                transform={reward?.asset?.symbol === 'MBRN' ? 'scale(1.2)' : 'none'}
              />
              <Text>{reward?.asset?.symbol}</Text>
            </HStack>
            <HStack>
              <Text>{shiftDigits(reward?.amount, -6).toString()}</Text>
              <RestakeButton reward={reward} />
            </HStack>
          </HStack>
        ))}
      </Stack>
      <TxButton
        isDisabled={!isGreaterThanZero(claimable)}
        isLoading={claim.isPending}
        onClick={() => claim.mutate()}
      >
        Claim
      </TxButton>
    </Stack>
  )
}

export default ClaimAndRestake
