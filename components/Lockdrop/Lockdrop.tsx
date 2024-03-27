import { HStack, Stack } from '@chakra-ui/react'
import Info from './Info'
import LockChart from './LockChart'
import LoackdropPane from './LockdropPane'

const Lockdrop = () => {
  return (
    <Stack gap="5">
      <Info />
      <LockChart />
      <LoackdropPane />
    </Stack>
  )
}

export default Lockdrop
