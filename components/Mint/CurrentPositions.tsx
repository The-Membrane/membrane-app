import { HStack, Stack, TabPanel, Text } from '@chakra-ui/react'
import { useCurrentPosition } from './hooks/useCurrentPosition'

const CurrentPositions = () => {
  const stats = useCurrentPosition()

  return (
    <TabPanel>
    <Stack gap="5">
      {stats.map(({ label, value, textColor = 'white' }) => (
        <HStack key={label + value} justifyContent="space-between">
          <Text variant="lable">{label}</Text>
          <Text variant="value" color={textColor}>{value}</Text>
        </HStack>
      ))}
    </Stack>
  </TabPanel>
  )
}

export default CurrentPositions