import { parseError } from '@/helpers/parseError'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useEffect, useState } from 'react'
import useWallet from './useWallet'
import { StdFee } from '@cosmjs/stargate'
import { QueryKey, useQuery } from '@tanstack/react-query'

type Simulate = {
  msgs: MsgExecuteContractEncodeObject[] | undefined | null
  amount: string | undefined
  enabled?: boolean
  queryKey?: QueryKey
}

const useSimulate = ({ msgs, amount, enabled = true, queryKey }: Simulate) => {
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const { isWalletConnected, getSigningStargateClient, estimateFee, address, chain } = useWallet()

  // clear error message when amount is changed
  useEffect(() => {
    if (amount === '' && !!errorMessage) setErrorMessage(null)
  }, [amount, errorMessage])

  const simulate = useQuery<[StdFee, number] | undefined, Error>({
    queryKey: ['simulate', amount, address, chain.chain_id, queryKey],
    queryFn: async () => {
      if (!isWalletConnected || !address || !msgs) return undefined

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
