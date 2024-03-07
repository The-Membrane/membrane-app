import { Box, Text } from '@chakra-ui/react'

export const badgeColors: Record<string, string> = {
  active: 'green.300',
  pending: 'yellow.300',
  rejected: 'red.300',
  executed: 'gray.300',
}

type Props = {
  status: keyof typeof badgeColors
}

export const Badge = ({ status }: Props) => (
  <Box px="2" py="1" borderRadius="sm" bg={badgeColors[status]}>
    <Text fontSize="xs" textTransform="capitalize" color="blackAlpha.800">
      {status}
    </Text>
  </Box>
)
