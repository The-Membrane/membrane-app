import { Card, HStack, Text } from '@chakra-ui/react'
import DelegateList from './DelegateList'
import BecomeDelegate from './BecomeDelegate'

const Delegate = () => {
  return (
    <Card w="full" p="8" alignItems="center" gap={5} h="full" justifyContent="space-between">
      <HStack justifyContent="space-between" w="full">
        <Text variant="value">Delegate</Text>
        <BecomeDelegate />
      </HStack>
      <DelegateList />
    </Card>
  )
}

export default Delegate
