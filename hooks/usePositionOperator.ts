import { useQuery } from '@tanstack/react-query'
import { useChainRoute } from '@/hooks/useChainRoute'
import useWallet from '@/hooks/useWallet'
import { getPublicClient } from '@/services/chain/client'
import { readPositionOperator, buildSetPositionOperator } from '@/services/chain/router'
import type { Address } from '@/config/evm/contracts'
import type { EvmCall } from '@/services/chain/types'

/**
 * Operator-consent hook for the CdpRouter.
 *
 * Reads Cdp.positionOperator(user, router) — true once the user has approved the
 * router to drive borrow/withdraw legs on their own positions. Also exposes the
 * one-time approval EvmCall (Cdp.setPositionOperator(router, true)) that CTA hooks
 * prepend to a combined router flow when the flag is not yet set.
 *
 * Reads are wallet-independent (services/chain/client.ts), but operator status is
 * per-user, so the query is gated on a connected address. 30s staleTime: the flag
 * flips at most once per user (first router use) and should refresh promptly after.
 */
export const usePositionOperator = () => {
  const { chainName } = useChainRoute()
  const { address, chain } = useWallet(chainName)

  const query = useQuery({
    queryKey: ['position_operator', address, chain?.id],
    queryFn: async () => {
      if (!address) return null
      return readPositionOperator(getPublicClient(), address as Address)
    },
    enabled: !!address,
    staleTime: 1000 * 30, // 30s
  })

  const isApproved = query.data === true

  // One-time consent call; prepend to a combined router flow when !isApproved.
  // After the first successful use the on-chain flag persists and this disappears.
  const approveOperatorMsg: EvmCall | null = buildSetPositionOperator(chain?.id, true)

  return { ...query, isApproved, approveOperatorMsg }
}

export default usePositionOperator
