import React, { useEffect, useMemo } from 'react'
import { Text, TextProps } from '@chakra-ui/react'
import { parseError } from '@/helpers/parseError'
import { Action } from '@/types/tx'

type Props = TextProps & {
  action: Action
}

const TxError = ({ action, ...textProps }: Props) => {
  const { isError, error } = action?.simulate || {}

  const errorMsg = parseError(isError ? error?.message : "")


  if (!errorMsg || errorMsg == " ") return null

  return (
    <Text fontSize="sm" color="red.500" {...textProps}>
      {errorMsg}
    </Text>
  )
}
export default TxError
