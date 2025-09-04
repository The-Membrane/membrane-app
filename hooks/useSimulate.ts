import { parseError } from '@/helpers/parseError'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useEffect, useState } from 'react'
import useWallet from './useWallet'
import { StdFee } from '@cosmjs/stargate'
import { useQuery } from '@tanstack/react-query'
import { useChainRoute } from './useChainRoute'
import { getGasConfig } from '@/config/gas'

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
      console.log('[useSimulate] queryFn start', {
        enabled,
        isWalletConnected,
        hasAddress: !!address,
        msgsCount: msgs?.length || 0,
        chainId: chain?.chain_id,
        routeChainName: chainName,
      })

      if (!enabled) {
        console.log('[useSimulate] Skipping: enabled is false')
        return undefined
      }
      if (!isWalletConnected) {
        console.log('[useSimulate] Skipping: wallet not connected')
        return undefined
      }
      if (!address) {
        console.log('[useSimulate] Skipping: no address')
        return undefined
      }
      if (!msgs || msgs.length === 0) {
        console.log('[useSimulate] Skipping: no msgs to simulate')
        return undefined
      }

      try {
        const signingClient = await getSigningStargateClient()
        setErrorMessage(null)

        // Get the estimated fee from the wallet
        const estimatedFee = await estimateFee(msgs)
        console.log('[useSimulate] estimatedFee', estimatedFee)

        // Determine buffer behavior
        const gasConfig = getGasConfig(chainName)
        const bufferMultiplier = 1.05 // default 5% buffer if not specified

        // Parse gas and compute buffered values
        const simulatedGasUnits = Math.max(0, parseInt(estimatedFee.gas || '0') || 0)
        const bufferedGasUnits = Math.ceil(simulatedGasUnits * bufferMultiplier)

        // Scale fee amounts proportionally to the gas increase.
        // Keep denom from estimate unless chain config explicitly specifies one.
        const denomFromEstimate = estimatedFee.amount?.[0]?.denom
        const denom = gasConfig?.denom || denomFromEstimate || 'uosmo'

        const originalAmount = estimatedFee.amount?.[0]?.amount || '0'
        const originalAmountNum = Math.max(0, parseInt(originalAmount || '0') || 0)
        const bufferedAmountNum = Math.ceil(originalAmountNum * bufferMultiplier)

        const finalFee: StdFee = {
          ...estimatedFee,
          gas: String(bufferedGasUnits),
          amount: [
            {
              denom,
              amount: String(bufferedAmountNum),
            },
          ],
        }

        console.log('[useSimulate] buffer applied', {
          originalGas: estimatedFee.gas,
          bufferedGas: finalFee.gas,
          originalAmount: estimatedFee.amount,
          newAmount: finalFee.amount,
          bufferMultiplier,
        })

        const simResult = await signingClient?.simulate(address, msgs, undefined)
        console.log('[useSimulate] simulate result', simResult)

        return Promise.all([finalFee, simResult])
      } catch (err: any) {
        const msg = parseError(err?.message || String(err)) || 'Simulation failed'
        console.error('[useSimulate] error', err)
        setErrorMessage(msg)
        throw err
      }
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
