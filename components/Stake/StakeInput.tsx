import { FormControl, FormLabel, Input, InputProps } from '@chakra-ui/react'
import React from 'react'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, FOCUS_STYLES } from '@/config/transitions'

export type StakeInputProps = {
  label: string
  value: string
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void
  readOnly?: boolean
}

export const StakeInput = ({ label, value, onChange, readOnly }: StakeInputProps) => {
  return (
    <FormControl display="flex" justifyContent="space-between" gap={SPACING.base} w="auto" alignItems="center">
      <Input
        type="number"
        placeholder="0.00"
        value={value}
        onChange={onChange}
        readOnly={readOnly}
        borderRadius={0}
        transition={TRANSITIONS.colors}
        _focus={FOCUS_STYLES.ring}
      />
      <FormLabel fontSize={TYPOGRAPHY.h2} fontWeight={TYPOGRAPHY.bold} w="full">
        {label}
      </FormLabel>
    </FormControl>
  )
}
