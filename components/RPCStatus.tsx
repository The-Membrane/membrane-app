import { rpcUrl } from '@/config/defaults'
import useAppState from '@/persisted-state/useAppState'
import { Alert, AlertIcon } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'
import React, { useMemo } from 'react'

const useRpcStatus = () => {
  const { appState } = useAppState()
  const rpc = useMemo(() => appState.rpcUrl ?? rpcUrl, [appState.rpcUrl])

  return useQuery({
    queryKey: ['rpc status', rpc],
    queryFn: async () => {
      const url = rpc + '/status'
      // console.log('Requesting URL:', url)
      try {
        const response = await fetch(url)
        // console.log('Response status:', response)
        const res = await response.json()
        if ('error' in res) throw new Error('rpc error')
        return res
      } catch (error) {
        console.error('Failed to fetch RPC status:', error)
        throw error
      }
    },
    refetchInterval: 60000,
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
