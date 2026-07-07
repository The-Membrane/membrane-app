import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'

/**
 * TODO(evm-migration): the Cosmos lockdrop allocations do not exist in the Solidity port
 * — Acquisition replaces launch mechanics. MBRN vesting is read via Vesting.sol
 * (unlockedFor / getAllocation) and surfaced through the protocol-claims aggregator
 * (components/Nav/hooks/useClaims.ts), not through a lockdrop allocation. Honest stub:
 * never runs (data stays undefined) so consumers fall back to empty state. Kept so the
 * Lockdrop component (TokenAllocation.tsx) keeps compiling.
 */
const useAllocation = (_run: boolean = true) => {
  const { address } = useWallet()

  return useQuery({
    queryKey: ['allocations', 'stub', address],
    queryFn: async (): Promise<any> => null,
    enabled: false,
  })
}

export default useAllocation
