import React, { useMemo } from 'react'
import { Text, TextProps } from '@chakra-ui/react'
import { parseError } from '@/helpers/parseError'
import { Action } from '@/types/tx'

type Props = TextProps & {
  action: Action
}

const TxError = ({ action, ...textProps }: Props) => {
  const { isError, error } = action?.simulate || {}
  
  const errorMessage = useMemo(() => {
    if (!error) return null
    return parseError(error)
  }, [error])

  if (!isError) return null

  return (
    <Text fontSize="sm" color="red.500" {...textProps}>
      {errorMessage}
    </Text>
  )
}
export default TxError
