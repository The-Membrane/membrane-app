import contracts from '@/config/contracts.json'
import useExecute from '@/hooks/useExecute'
import useWallet from '@/hooks/useWallet'
import { SigningCosmWasmClient } from '@cosmjs/cosmwasm-stargate'

export type UseUpdateCustomDecalParams = {
  tokenId: string
  svg: string
  contractAddress?: string
}

const resolveCarContractAddress = (override?: string) => {
  if (override) return override
  return (contracts as any).carNft || (contracts as any).car || (contracts as any).carNFT
}

export default function useUpdateCustomDecal(params: UseUpdateCustomDecalParams) {
  const { address, getSigningCosmWasmClient } = useWallet()

  return useExecute({
    onSubmit: async () => {
      if (!address) return Promise.reject(new Error('Wallet not connected'))

      const contractAddress = resolveCarContractAddress(params.contractAddress)
      if (!contractAddress) return Promise.reject(new Error('Car contract address missing in contracts.json'))

      const signingClient: SigningCosmWasmClient = await getSigningCosmWasmClient()
      const msg = {
        update_custom_decal: {
          token_id: params.tokenId,
          svg: params.svg,
        },
      }
      return signingClient.execute(address, contractAddress, msg, 'auto')
    },
  })
} 