import { HStack, Stack, TabPanel, Card, Text } from '@chakra-ui/react'
import { useCurrentPosition } from './hooks/useCurrentPosition'
import React from 'react'
import { colors } from '@/config/defaults'

const CurrentPositions = () => {
  const stats = useCurrentPosition()

  return (
    <Card boxShadow={"0 0 25px rgba(90, 90, 90, 0.5)"} minW="363px" gap="12" h="max-content" px="2">
      <Stack gap="5" padding="3%" paddingTop="0">
        <Text color={stats.health < 10 ? colors.alert : undefined} variant="title" textTransform={"none"} alignSelf="center" fontSize="xl" letterSpacing="1px" display="flex">
          Health: {stats.health}%
        </Text>
        {stats.stats.map(({ label, value, textColor = 'white' }) => (
          <HStack key={label + value} justifyContent="space-between">
            <Text variant="lable" textTransform={"none"} letterSpacing={0}>{label}</Text>
            <Text variant="value" color={textColor}>{value}</Text>
          </HStack>
        ))}
      </Stack>
    </Card>
  )
}

export default CurrentPositions