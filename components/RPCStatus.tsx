import { Alert, AlertIcon } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'
import React from 'react'
import { getPublicClient } from '@/services/chain/client'
import { DEFAULT_EVM_CHAIN } from '@/config/evm/chains'

/**
 * EVM RPC health banner. Was: Cosmos `<rpc>/status` poll against appState.rpcUrl
 * (dead celatone endpoints post-migration). Now probes the configured EVM RPC with
 * eth_chainId and flags mismatched/unreachable nodes.
 */
const useRpcStatus = () => {
  return useQuery({
    queryKey: ['evm rpc status', DEFAULT_EVM_CHAIN.id],
    queryFn: async () => {
      const chainId = await getPublicClient().getChainId()
      if (chainId !== DEFAULT_EVM_CHAIN.id) throw new Error(`wrong chain: ${chainId}`)
      return chainId
    },
    refetchInterval: 60000,
    retry: 1,
  })
}

const RPCStatus = () => {
  const { isError } = useRpcStatus()

  if (!isError) return null

  return (
    <Alert status="error" borderRadius="md">
      <AlertIcon />
      RPC node is unreachable — is the chain running? (expected {DEFAULT_EVM_CHAIN.name})
    </Alert>
  )
}

export default RPCStatus
