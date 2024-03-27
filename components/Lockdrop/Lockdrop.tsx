import { HStack, Stack } from '@chakra-ui/react'
import Info from './Info'
import LockChart from './LockChart'
import LoackdropPane from './LockdropPane'

const Lockdrop = () => {
  return (
    <HStack gap="5" justifyContent="space-around" alignItems="flex-start">
      <Stack w="full" gap="5" maxW="600px">
        <Info />
        <LockChart />
        <LoackdropPane />
      </Stack>
    </HStack>
  )
}

export default Lockdrop
