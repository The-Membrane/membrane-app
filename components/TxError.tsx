import React, { useMemo } from 'react'
import { Text } from '@chakra-ui/react'
import { parseError } from '@/helpers/parseError'
import { Action } from '@/types/tx'

type Props = {
  action: Action
}

const TxError = ({ action }: Props) => {
  const { isError, error } = action?.simulate || {}
  if (!isError) return null

  const errorMessage = useMemo(() => {
    if (!error) return null
    return parseError(error)
  }, [error])

  return (
    <Text fontSize="sm" color="red.500" mt="2">
      {errorMessage}
    </Text>
  )
}

export default TxError
