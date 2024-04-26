import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Card, HStack, Image, Stack, Text } from '@chakra-ui/react'
import { useMemo } from 'react'
import { TxButton } from '@/components/TxButton'
import useStakingClaim from './hooks/useStakingClaim'
import useStaked from './hooks/useStaked'
import { isGreaterThanZero } from '@/helpers/num'

const Claim = () => {
  const { data: staked } = useStaked()
  const mbrnAsset = useAssetBySymbol('MBRN')
  const claim = useStakingClaim().action

  const claimable = useMemo(() => {
    if (!staked?.rewards || !mbrnAsset) return '0.00'

    return shiftDigits(staked?.rewards?.accrued_interest, -mbrnAsset?.decimal).toString()
  }, [staked, mbrnAsset])

  return (
    <Card w="full" p="8" alignItems="center" gap={5} h="full" justifyContent="space-between">
      <Text variant="title" fontSize="24px">
        Claim
      </Text>

      <Stack>
        <HStack boxSize={8} alignItems="center" justifyContent="center">
          <Text fontSize="xl">{claimable}</Text>
          <Image src={mbrnAsset?.logo} alt="MBN" />
        </HStack>
      </Stack>

      <TxButton
        maxW="200px"
        isDisabled={!isGreaterThanZero(claimable)}
        isLoading={claim.simulate.isLoading || claim.tx.isPending}
        onClick={() => {         
          claim.simulate.refetch().then(() => {
            claim.tx.mutate()
          })
        }}
      >
        Claim
      </TxButton>
    </Card>
  )
}

export default Claim
