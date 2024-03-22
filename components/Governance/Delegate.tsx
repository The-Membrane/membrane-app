import { Card, HStack, Text } from '@chakra-ui/react'
import DelegateList from './DelegateList'

type Props = {}

const Delegate = (props: Props) => {
  return (
    <Card w="full" p="8" alignItems="center" gap={5} h="full" justifyContent="space-between">
      <HStack justifyContent="space-between" w="full">
        <Text variant="value">Delegate</Text>
      </HStack>
      <DelegateList />
    </Card>
  )
}

export default Delegate
