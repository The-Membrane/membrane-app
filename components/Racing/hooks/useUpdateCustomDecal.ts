import useExecute from '@/hooks/useExecute'

export type UseUpdateCustomDecalParams = {
  tokenId: string
  svg: string
  contractAddress?: string
}

/**
 * TODO(evm-migration): the Racing mini-game car NFT (custom decal) contract has NO
 * equivalent in the Solidity port. This CTA hook's submit is inert (rejects) until/if
 * racing contracts are ported. The useExecute mutation return shape is preserved so
 * consumers keep compiling.
 */
export default function useUpdateCustomDecal(_params: UseUpdateCustomDecalParams) {
  return useExecute({
    onSubmit: () =>
      Promise.reject(
        new Error('Racing custom decals are not available: no EVM contract in the Solidity port'),
      ),
  })
}