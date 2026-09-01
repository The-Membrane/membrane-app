import { Alert, AlertIcon, Text } from '@chakra-ui/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import React, { useEffect, useRef, useState } from 'react'
import { getPublicClient } from '@/services/chain/client'
import { DEFAULT_EVM_CHAIN } from '@/config/evm/chains'

/**
 * EVM RPC health banner. Was: Cosmos `<rpc>/status` poll against appState.rpcUrl
 * (dead celatone endpoints post-migration). Now probes the configured EVM RPC with
 * eth_chainId and flags mismatched/unreachable nodes.
 *
 * Poll is 12s while healthy, not 60s: at 60s a dead RPC kept serving confident cached
 * numbers for up to a minute (tools/ui-sensory/FINDINGS.md). Once DOWN it backs off to
 * 45s — the healthy-state interval is what bounds detection latency, and re-probing a
 * dead node every 12s (x viem's internal retries) just floods the console and keeps
 * the network from ever idling (it broke Playwright's networkidle waits). The banner
 * states the age of what is on screen; recovery invalidates every active query so the
 * stale numbers refresh the moment fresh ones are obtainable.
 */
const RPC_POLL_HEALTHY_MS = 12_000
const RPC_POLL_DOWN_MS = 45_000

export const useRpcStatus = () => {
  return useQuery({
    queryKey: ['evm rpc status', DEFAULT_EVM_CHAIN.id],
    queryFn: async () => {
      const chainId = await getPublicClient().getChainId()
      if (chainId !== DEFAULT_EVM_CHAIN.id) throw new Error(`wrong chain: ${chainId}`)
      return chainId
    },
    refetchInterval: (query) =>
      query.state.status === 'error' ? RPC_POLL_DOWN_MS : RPC_POLL_HEALTHY_MS,
    retry: 0,
  })
}

const RPCStatus = () => {
  const { isError } = useRpcStatus()
  const queryClient = useQueryClient()
  const [downSince, setDownSince] = useState<number | null>(null)
  const wasError = useRef(false)

  useEffect(() => {
    if (isError && !wasError.current) {
      setDownSince(Date.now())
      // Deliberately NO invalidation here: refetching against a dead RPC cannot
      // produce fresher data — it can only storm every active query into errors.
      // The staleness is communicated by the banner's explicit age line instead.
    }
    if (!isError && wasError.current) {
      setDownSince(null)
      // Recovered: NOW refresh everything that aged during the outage.
      queryClient.invalidateQueries()
    }
    wasError.current = isError
  }, [isError, queryClient])

  // Re-render the age figure while unhealthy. Coarse (minutes) and slow (30s tick) on
  // purpose: a seconds counter reflowed the banner every 5s, which is a layout shift
  // on exactly the surface that must not add motion.
  const [, tick] = useState(0)
  useEffect(() => {
    if (!isError) return
    const id = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [isError])

  if (!isError) return null

  const downMins = downSince ? Math.floor((Date.now() - downSince) / 60_000) : null

  return (
    <Alert status="error" borderRadius={0}>
      <AlertIcon />
      <Text>
        RPC node is unreachable. Is the chain running? (expected {DEFAULT_EVM_CHAIN.name})
        {' '}Numbers on this page stopped updating
        {downMins !== null && downMins >= 1 ? ` over ${downMins}m ago.` : ' just now.'}
      </Text>
    </Alert>
  )
}

export default RPCStatus
