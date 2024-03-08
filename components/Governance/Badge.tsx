import { Box, BoxProps, Text } from '@chakra-ui/react'

export const badgeColors: Record<string, string> = {
  active: 'blue.300',
  pending: 'yellow.300',
  executed: 'gray.300',
  passed: 'green.300',
  rejected: 'red.300',
  amended: 'yellow.300',
  expired: 'orange.300',
}

type Props = BoxProps & {
  badge: keyof typeof badgeColors
}

export const Badge = ({ badge, ...boxProps }: Props) => (
  <Box px="2" py="1" borderRadius="sm" bg={badgeColors[badge]} {...boxProps}>
    <Text fontSize="xs" textTransform="capitalize" color="blackAlpha.800">
      {badge}
    </Text>
  </Box>
)
