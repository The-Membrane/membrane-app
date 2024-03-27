import React from 'react'
import { Button, HStack, Text } from '@chakra-ui/react'

type Props = {
  label: string
  value?: string | number
  onMaxClick?: () => void
}
const Balance = ({ label, value = 0, onMaxClick }: Props) => {
  return (
    <HStack ml={3} w="full" gap="1">
      <Text fontSize="sm">{label}:</Text>
      <Button variant="link" fontSize="sm" onClick={onMaxClick}>
        {value}
      </Button>
    </HStack>
  )
}

export default Balance
