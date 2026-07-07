import { useQuery } from '@tanstack/react-query'
import { DEFAULT_CHAIN } from '@/config/chains'

/**
 * TODO(evm-migration): these Stargaze client / block-info helpers served the Brane NFT
 * auction, which does NOT exist in the Solidity port (no brane_auction contract ported).
 * The cosmos-kit signing-client (getSigningStargateClient) and CosmWasm block queries have
 * no EVM analog here, so both hooks are inert (disabled, null data). No consumers remain;
 * kept as stubs pending NFT-auction UI removal in the component-layer wave.
 */
export const useClient = (chain_name: string = DEFAULT_CHAIN) => {
  return useQuery({
    queryKey: [chain_name + ' client'],
    queryFn: async () => null,
    enabled: false,
  })
}

export const useBlockInfo = (chain_name: string = DEFAULT_CHAIN) => {
  return useQuery({
    queryKey: [chain_name + ' block info'],
    queryFn: async () =>
      ({ currentBlock: undefined, currentHeight: undefined }) as {
        currentBlock: unknown | undefined
        currentHeight: number | undefined
      },
    enabled: false,
  })
}
