import { HStack, SimpleGrid, Stack, Text } from '@chakra-ui/react'
import Claim from './Claim'
import Staking from './Staking'
import TokenAllocation from './TokenAllocation'
import Unstake from './Unstake'
import Governance from '@/components/Governance'

const Stake = () => {
  return (
    <HStack alignItems="flex-start" gap="10" w="full">
      <Governance />
      <Stack w="full">
        <Text variant="title">Governance</Text>
        <SimpleGrid columns={1} gap="5" h="265px">
          <Staking />
          <Unstake />
          <Claim />
          <TokenAllocation />
        </SimpleGrid>
      </Stack>
    </HStack>
  )
}

export default Stake
