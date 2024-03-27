import { FormControl, FormLabel, Input, InputProps } from '@chakra-ui/react'
import React from 'react'

export type StakeInputProps = {
  label: string
  value: string
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void
  readOnly?: boolean
}

export const StakeInput = ({ label, value, onChange, readOnly }: StakeInputProps) => {
  return (
    <FormControl display="flex" justifyContent="space-between" gap={4} w="auto" alignItems="center">
      <Input
        type="number"
        placeholder="0.00"
        value={value}
        onChange={onChange}
        readOnly={readOnly}
      />
      <FormLabel fontSize="24px" fontWeight="700" w="full">
        {label}
      </FormLabel>
    </FormControl>
  )
}
