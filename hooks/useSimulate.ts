import { parseError } from '@/helpers/parseError'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useEffect, useState } from 'react'
import useWallet from './useWallet'
import { StdFee } from '@cosmjs/stargate'
import { useQuery } from '@tanstack/react-query'
import { useChainRoute } from './useChainRoute'
import { getGasConfig, calculateGasFeeWithBuffer } from '@/config/gas'

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
  const { isWalletConnected, getSigningStargateClient, estimateFee, address, chain } = useWallet()

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

      if (gasConfig) {
        // Use simulated fee with buffer instead of overriding with gas config
        const simulatedGas = estimatedFee.gas
        const bufferedGas = Math.ceil(parseInt(simulatedGas) * (gasConfig.gasBuffer || 1.0))

        finalFee = {
          ...estimatedFee,
          gas: bufferedGas.toString(),
          amount: [
            {
              denom: gasConfig.denom,
              amount: calculateGasFeeWithBuffer(chainName, bufferedGas.toString()),
            }
          ]
        }

        console.log(`🚀 Gas buffer applied for ${chainName}:`, {
          originalGas: estimatedFee.gas,
          bufferedGas: bufferedGas.toString(),
          originalAmount: estimatedFee.amount,
          newAmount: finalFee.amount,
          gasPrice: `${gasConfig.gasPrice} ${gasConfig.denom}/gas`,
          bufferMultiplier: gasConfig.gasBuffer
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
