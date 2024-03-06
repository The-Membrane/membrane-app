import { SimpleGrid, Stack } from '@chakra-ui/react'
import Claim from './Claim'
import Staking from './Staking'
import TokenAllocation from './TokenAllocation'
import Unstake from './Unstake'

const Stake = () => {
  return (
    <Stack>
      <SimpleGrid columns={2} gap="5" h="265px">
        <Staking />
        <Unstake />
        <Claim />
        <TokenAllocation />
      </SimpleGrid>
    </Stack>
  )
}

export default Stake
