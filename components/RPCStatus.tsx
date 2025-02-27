import { rpcUrl } from '@/config/defaults'
import { Alert, AlertIcon } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'
import React from 'react'

const useRpcStatus = () => {
  return useQuery({
    queryKey: ['rpc status'],
    queryFn: async () => {
      const url = rpcUrl + '/status'
      console.log('Requesting URL:', url)
      try {
        const response = await fetch(url)
        console.log('Response status:', response)
        const res = await response.json()
        if ('error' in res) throw new Error('rpc error')
        return res
      } catch (error) {
        console.error('Failed to fetch RPC status:', error)
        throw error
      }
    },
    // refetchInterval: 60000,
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
