import { useMemo } from 'react'
import type { EvmFeeEstimate } from '@/services/chain/types'

/**
 * TODO(evm-migration): was Cosmos StdFee math (gas string + fee coin, shifted by the base
 * asset's decimals). Re-expressed over EvmFeeEstimate (services/chain/types.ts): EIP-1559
 * fees are already ETH-denominated, so we surface the estimate's gas units and its
 * pre-formatted ETH ceiling directly rather than shifting a micro-denom coin. The old
 * `./useBaseAsset` dependency (a Cosmos base-asset lookup) no longer exists and is dropped.
 */
const useGasAndFee = (fee: EvmFeeEstimate | undefined) => {
  return useMemo(
    () => ({
      gas: fee?.gas?.toString() ?? '0',
      fee: fee?.totalFormatted ?? '0',
    }),
    [fee],
  )
}

export default useGasAndFee
