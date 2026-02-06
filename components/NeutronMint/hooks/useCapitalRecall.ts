import { useQuery } from '@tanstack/react-query'
import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import { shiftDigits } from '@/helpers/math'
import { PositionResponse } from '@/contracts/codegen/positions/Positions.types'
import useAppState from '@/persisted-state/useAppState'

interface DeploymentVenue {
  address: string
  deployed_debt_amount: string
  failed_liquidation?: boolean
}

export interface VenueRecallResult {
  address: string
  amount: number
}

export interface CapitalRecallResult {
  total: number
  perVenue: VenueRecallResult[]
}

/**
 * Helper function to query RetrievableCDT from all deployment venues
 * and return per-venue breakdown + total
 */
async function getCapitalRecallBreakdown(
  position: PositionResponse,
  userAddress: string,
  cosmWasmClient: CosmWasmClient | null
): Promise<CapitalRecallResult> {
  if (!cosmWasmClient || !position) {
    return { total: 0, perVenue: [] }
  }

  // Access deployed_to field (may not be in TypeScript types yet)
  // @ts-ignore - deployed_to exists in PositionResponse but may not be in generated types
  const deployedTo = (position as any).deployed_to as DeploymentVenue[] | undefined

  if (!deployedTo || deployedTo.length === 0) {
    return { total: 0, perVenue: [] }
  }

  try {
    // Query RetrievableCDT from each deployment venue
    const queries = deployedTo.map(async (venue): Promise<VenueRecallResult> => {
      try {
        const response = await cosmWasmClient.queryContractSmart(venue.address, {
          retrievable_c_d_t: {
            user: userAddress,
          },
        })

        // Response is Uint128 as string
        const raw = typeof response === 'string' ? response : (response as any).amount || '0'
        const amount = shiftDigits(raw, -6).toNumber()
        return { address: venue.address, amount }
      } catch (error) {
        console.error(`Error querying RetrievableCDT from venue ${venue.address}:`, error)
        return { address: venue.address, amount: 0 }
      }
    })

    const perVenue = await Promise.all(queries)
    const total = perVenue.reduce((sum, v) => sum + v.amount, 0)

    return { total, perVenue }
  } catch (error) {
    console.error('Error calculating Capital Recall amount:', error)
    return { total: 0, perVenue: [] }
  }
}

/**
 * Hook to get the Capital Recall breakdown for a position
 */
export const useCapitalRecallAmount = (
  position: PositionResponse | undefined,
  userAddress: string | undefined
) => {
  const { appState } = useAppState()
  const { data: cosmWasmClient } = useCosmWasmClient(appState.rpcUrl)

  return useQuery<CapitalRecallResult>({
    queryKey: ['capital_recall_amount', position?.position_id, userAddress, cosmWasmClient],
    queryFn: async () => {
      if (!position || !userAddress || !cosmWasmClient) {
        return { total: 0, perVenue: [] }
      }
      return getCapitalRecallBreakdown(position, userAddress, cosmWasmClient)
    },
    enabled: !!position && !!userAddress && !!cosmWasmClient,
    staleTime: 1000 * 30, // 30 seconds
  })
}

export default useCapitalRecallAmount

