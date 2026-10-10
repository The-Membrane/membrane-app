import {
  Box,
  Button,
  HStack,
  Popover,
  PopoverBody,
  PopoverContent,
  PopoverTrigger,
  Text,
} from '@chakra-ui/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import React, { useEffect, useRef, useState } from 'react'
import { getPublicClient } from '@/services/chain/client'
import { DEFAULT_EVM_CHAIN } from '@/config/evm/chains'

/**
 * EVM RPC health indicator. Was: Cosmos `<rpc>/status` poll against appState.rpcUrl
 * (dead celatone endpoints post-migration). Now probes the configured EVM RPC with
 * eth_chainId and flags mismatched/unreachable nodes.
 *
 * Poll is 12s while healthy, not 60s: at 60s a dead RPC kept serving confident cached
 * numbers for up to a minute (tools/ui-sensory/FINDINGS.md). Once DOWN it backs off to
 * 45s — the healthy-state interval is what bounds detection latency, and re-probing a
 * dead node every 12s (x viem's internal retries) just floods the console and keeps
 * the network from ever idling (it broke Playwright's networkidle waits). Recovery
 * invalidates active queries so data fetched through that RPC can refresh.
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
  const [everDown, setEverDown] = useState(false)
  const wasError = useRef(false)

  useEffect(() => {
    if (isError && !wasError.current) {
      setDownSince(Date.now())
      setEverDown(true)
      // Deliberately NO invalidation here: refetching against a dead RPC cannot
      // produce fresher data — it can only storm every active query into errors.
      // The compact control reports how long the RPC has been unavailable.
    }
    if (!isError && wasError.current) {
      setDownSince(null)
      // Recovered: NOW refresh everything that aged during the outage.
      queryClient.invalidateQueries()
    }
    wasError.current = isError
  }, [isError, queryClient])

  // Keep the detail's minute count current without changing the nav control's width.
  const [, tick] = useState(0)
  useEffect(() => {
    if (!isError) return
    const id = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [isError])

  const downMins = downSince ? Math.floor((Date.now() - downSince) / 60_000) : null

  return (
    <>
      <Box
        as="span"
        position="absolute"
        w="1px"
        h="1px"
        overflow="hidden"
        clipPath="inset(50%)"
        whiteSpace="nowrap"
        role="status"
        aria-live="polite"
      >
        {isError
          ? 'Local contract RPC unavailable. On-chain actions may fail.'
          : everDown
            ? 'Local contract RPC restored.'
            : ''}
      </Box>
      {isError && (
        <Popover placement="bottom-end" isLazy>
          <PopoverTrigger>
            <Button
              aria-label="RPC offline; view connection details"
              size="sm"
              variant="ghost"
              minW={{ base: '40px', lg: 'auto' }}
              h={{ base: '40px', lg: '32px' }}
              px={{ base: 2, lg: 2 }}
              border="none"
              borderRadius={0}
              color="var(--m-danger)"
              fontSize="xs"
              fontWeight="semibold"
              letterSpacing="0.08em"
              _hover={{ bg: 'var(--m-bg-tertiary)', boxShadow: '0 2px 8px rgba(0, 0, 0, 0.2)' }}
              _active={{ bg: 'var(--m-bg-tertiary)', boxShadow: '0 1px 3px rgba(0, 0, 0, 0.15)' }}
              _focus={{ boxShadow: 'none' }}
              _focusVisible={{ boxShadow: '0 0 0 2px var(--m-border-strong)' }}
            >
              <HStack spacing={2}>
                <Box
                  as="span"
                  display="inline-block"
                  w="7px"
                  h="7px"
                  borderRadius="full"
                  bg="var(--m-danger)"
                  aria-hidden="true"
                />
                <Text as="span" display={{ base: 'none', lg: 'inline' }}>
                  RPC OFFLINE
                </Text>
              </HStack>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            w="min(300px, calc(100vw - 24px))"
            borderRadius={0}
            borderColor="var(--m-border-medium)"
            bg="var(--m-bg-secondary)"
            color="var(--m-text-primary)"
            boxShadow="0 8px 24px rgba(0, 0, 0, 0.25)"
            _focus={{ outline: 'none' }}
          >
            <PopoverBody p={4}>
              <Text fontSize="sm" fontWeight="semibold">
                Local contract RPC unavailable
              </Text>
              <Text mt={2} fontSize="sm" color="var(--m-text-secondary)">
                On-chain actions may fail. Expected {DEFAULT_EVM_CHAIN.name}.
                {downMins !== null && downMins >= 1
                  ? ` Offline for at least ${downMins} minute${downMins === 1 ? '' : 's'}.`
                  : ''}
              </Text>
            </PopoverBody>
          </PopoverContent>
        </Popover>
      )}
    </>
  )
}

export default RPCStatus
