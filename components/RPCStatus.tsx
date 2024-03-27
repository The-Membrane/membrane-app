import { rpcUrl } from '@/config/defaults'
import { Alert, AlertIcon } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'
import React from 'react'

const useRpcStatus = () => {
  return useQuery({
    queryKey: ['rpc status'],
    queryFn: async () => {
      const url = rpcUrl + '/status'
      const res = await fetch(url).then((res) => res.json())
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
