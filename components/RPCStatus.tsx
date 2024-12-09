import { Alert, AlertIcon } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'
import React from 'react'
import useRPCState from './useRPCState'

const useRpcStatus = () => {
  const { rpcState, setRPCState } = useRPCState()

  return useQuery({
    queryKey: ['rpc status', rpcState.urlIndex],
    queryFn: async () => {
      const url = rpcState.rpcURLs[rpcState.urlIndex] + '/status'
      const res = await fetch(url).then((res) => res.json())
      if ('error' in res && rpcState.urlIndex < rpcState.rpcURLs.length - 1) setRPCState({ urlIndex: rpcState.urlIndex + 1 })
      if ('error' in res) throw new Error('rpc error')
      return res
    },
    refetchInterval: 60000, // every minute
  })
}

const RPCStatus = () => {
  const { isError } = useRpcStatus()

  if (!isError) return null

  return (
    <Alert status="error" borderRadius="md">
      <AlertIcon />
      RPC node is experiencing issues, please try again later.
    </Alert>
  )
}

export default RPCStatus
