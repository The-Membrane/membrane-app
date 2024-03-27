import { SimpleGrid, Stack } from '@chakra-ui/react'
import Claim from './Claim'
import Stake from './Stake'
import TokenAllocation from './TokenAllocation'
import Unstake from './Unstake'

const Governance = () => {
  return (
    <Stack>
      <SimpleGrid columns={2} gap="5" h="265px">
        <Stake />
        <Unstake />
        <Claim />
        <TokenAllocation />
      </SimpleGrid>
    </Stack>
  )
}

export default Governance
