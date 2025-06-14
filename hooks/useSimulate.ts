import { parseError } from '@/helpers/parseError'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useEffect, useState } from 'react'
import useWallet from './useWallet'
import { StdFee } from '@cosmjs/stargate'
import { useQuery } from '@tanstack/react-query'
import { useChainRoute } from './useChainRoute'

type Simulate = {
  msgs: MsgExecuteContractEncodeObject[] | undefined | null
  amount: string | undefined
  enabled?: boolean
  queryKey?: string[]
  chain_id: string
}

const useSimulate = ({ msgs, amount, enabled = false, queryKey = [], chain_id }: Simulate) => {
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const { chainName } = useChainRoute()
  const { isWalletConnected, getSigningStargateClient, estimateFee, address, chain } = useWallet(chainName)

  // clear error message when amount is changed
  useEffect(() => {
    if (amount === '' && !!errorMessage) setErrorMessage(null)
  }, [amount, errorMessage])

  const simulate = useQuery<[StdFee, number] | undefined, Error>({
    queryKey: ['simulate', amount, address, chain.chain_id, ...queryKey],
    queryFn: async () => {
      // console.log("in useSimulate.ts", !isWalletConnected, !address, !msgs)
      if (!isWalletConnected || !address || !msgs) return undefined
      // console.log("in useSimulate.ts, after")

      const signingClient = await getSigningStargateClient()
      setErrorMessage(null)
      return Promise.all([estimateFee(msgs), signingClient?.simulate(address, msgs, undefined)])
    },
    enabled: enabled && (msgs?.length || 0) > 0 && isWalletConnected,
    retry: false,
    staleTime: 30000, // data considered "fresh" for 30 seconds
  })

  return {
    ...simulate,
    errorMessage,
  }
}

export default useSimulate
