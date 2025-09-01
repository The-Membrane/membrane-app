import { parseError } from '@/helpers/parseError'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useEffect, useState } from 'react'
import useWallet from './useWallet'
import { StdFee } from '@cosmjs/stargate'
import { useQuery } from '@tanstack/react-query'
import { useChainRoute } from './useChainRoute'
import { getGasConfig, calculateGasFee } from '@/config/gas'

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
      if (!isWalletConnected || !address || !msgs || msgs.length === 0) return undefined
      // console.log("in useSimulate.ts, after")

      const signingClient = await getSigningStargateClient()
      setErrorMessage(null)

      // Get the estimated fee from the wallet
      const estimatedFee = await estimateFee(msgs)

      // Check if we need to override gas parameters for this chain
      const gasConfig = getGasConfig(chainName)
      let finalFee = estimatedFee

      if (gasConfig && gasConfig.gasLimit) {
        // Override gas parameters for chains with explicit gas configuration
        finalFee = {
          ...estimatedFee,
          gas: gasConfig.gasLimit,
          amount: [
            {
              denom: gasConfig.denom,
              amount: calculateGasFee(chainName, gasConfig.gasLimit),
            }
          ]
        }

        console.log(`🚀 Gas override for ${chainName}:`, {
          originalGas: estimatedFee.gas,
          newGas: gasConfig.gasLimit,
          originalAmount: estimatedFee.amount,
          newAmount: finalFee.amount,
          gasPrice: `${gasConfig.gasPrice} ${gasConfig.denom}/gas`
        })
      }

      return Promise.all([finalFee, signingClient?.simulate(address, msgs, undefined)])
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
