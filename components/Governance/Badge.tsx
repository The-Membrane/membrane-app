import { Box, BoxProps, Text } from '@chakra-ui/react'
import { badgeColors } from './badgeColors'

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
