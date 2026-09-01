import React from 'react'
import { Button, HStack, Text } from '@chakra-ui/react'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'

type Props = {
  label: string
  value?: string | number
  onMaxClick?: () => void
}
const Balance = ({ label, value = 0, onMaxClick }: Props) => {
  return (
    <HStack ml={SPACING.md} w="full" gap={SPACING.xs}>
      <Text fontSize={TYPOGRAPHY.small}>{label}:</Text>
      <Button variant="link" fontSize={TYPOGRAPHY.small} onClick={onMaxClick} _focus={FOCUS_STYLES.ring}>
        {value}
      </Button>
    </HStack>
  )
}

export default Balance
