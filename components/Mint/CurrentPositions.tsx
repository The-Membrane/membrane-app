import { HStack, Stack, TabPanel, Card, Text } from '@chakra-ui/react'
import { useCurrentPosition } from './hooks/useCurrentPosition'
import React from 'react'

const CurrentPositions = () => {
  const stats = useCurrentPosition()

  return (
    <Card minW="363px" gap="12" h="max-content" px="2">
    <Stack gap="5" padding="3%">
      {stats.map(({ label, value, textColor = 'white' }) => (
        <HStack key={label + value} justifyContent="space-between">
          <Text variant="lable">{label}</Text>
          <Text variant="value" color={textColor}>{value}</Text>
        </HStack>
      ))}
    </Stack>
  </Card>
  )
}

export default CurrentPositions