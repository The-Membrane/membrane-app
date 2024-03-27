import { Text, HStack } from '@chakra-ui/react'
import React from 'react'

export const LineItem = ({
  label,
  value,
}: {
  label: string
  value: string | number | undefined
}) => (
  <HStack justifyContent="space-between">
    <Text fontWeight="bold" fontSize="xs" color="white">
      {label}
    </Text>
    <Text fontWeight="bold" fontSize="xs" color="white">
      {value}
    </Text>
  </HStack>
)
