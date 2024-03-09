import Governance from '@/components/Governance'
import { HStack, Stack, Text } from '@chakra-ui/react'
import ManageStake from './ManageStake'

const Stake = () => {
  return (
    <HStack gap="10" w="full" alignItems="flex-start">
      <Governance />
      <Stack w="full">
        <Text variant="title">Governance</Text>
        <ManageStake />
      </Stack>
    </HStack>
  )
}

export default Stake
