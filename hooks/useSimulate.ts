import { parseError } from '@/helpers/parseError'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useEffect, useState } from 'react'
import useWallet from './useWallet'
import { StdFee } from '@cosmjs/stargate'
import { useQuery } from '@tanstack/react-query'
import { useChainRoute } from './useChainRoute'
import { getGasConfig } from '@/config/gas'

// Configuration for retry behavior
const SIMULATION_CONFIG = {
  maxRetries: 3,
  baseDelay: 1000, // 1 second
  maxDelay: 10000, // 10 seconds
  staleTime: 15000, // 15 seconds
  gcTime: 60000, // 1 minute
  fallbackGas: '1000000',
  fallbackAmount: '2500',
} as const

// Helper function to categorize errors for better debugging
const categorizeError = (errorMessage: string): string => {
  const message = errorMessage.toLowerCase()

  if (message.includes('network') || message.includes('timeout') || message.includes('connection')) {
    return 'NETWORK'
  }
  if (message.includes('insufficient funds') || message.includes('user denied') || message.includes('request rejected')) {
    return 'USER'
  }
  if (message.includes('unauthorized') || message.includes('car not found') || message.includes('track not found')) {
    return 'CONTRACT'
  }
  if (message.includes('simulation') || message.includes('gas') || message.includes('fee')) {
    return 'SIMULATION'
  }
  if (message.includes('rpc') || message.includes('endpoint')) {
    return 'RPC'
  }

  return 'UNKNOWN'
}

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

        // Get the estimated fee from the wallet with fallback
        let estimatedFee: StdFee
        try {
          estimatedFee = await estimateFee(msgs)
          console.log('[useSimulate] estimatedFee from wallet', estimatedFee)
        } catch (feeError) {
          console.warn('[useSimulate] Wallet fee estimation failed, using fallback:', feeError)

          // Fallback fee estimation
          const gasConfig = getGasConfig(chainName)
          const fallbackGas = SIMULATION_CONFIG.fallbackGas
          const fallbackDenom = gasConfig?.denom || 'uosmo'
          const fallbackAmount = SIMULATION_CONFIG.fallbackAmount

          estimatedFee = {
            gas: fallbackGas,
            amount: [{
              denom: fallbackDenom,
              amount: fallbackAmount,
            }],
          }
          console.log('[useSimulate] Using fallback fee:', estimatedFee)
        }

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
        const errorMessage = err?.message || String(err)
        const msg = parseError(errorMessage) || 'Simulation failed'

        // Categorize the error for better debugging
        const errorCategory = categorizeError(errorMessage)
        console.error(`[useSimulate] ${errorCategory} error:`, {
          error: err,
          message: errorMessage,
          category: errorCategory,
          chainName,
          address: address?.substring(0, 10) + '...',
          msgsCount: msgs?.length || 0
        })

        setErrorMessage(msg)
        throw err
      }
    },
    enabled: enabled && (msgs?.length || 0) > 0 && isWalletConnected,
    retry: (failureCount, error) => {
      // Don't retry if it's a user error (insufficient funds, etc.)
      const errorMessage = error?.message || String(error)
      const isUserError = [
        'insufficient funds',
        'user denied',
        'request rejected',
        'unauthorized',
        'car not found',
        'track not found',
        'invalid car count',
        'invalid action',
        'invalid track',
        'invalid race config',
        'simulation error',
        'q-learning error'
      ].some(userError => errorMessage.toLowerCase().includes(userError))

      if (isUserError) {
        console.log('[useSimulate] Not retrying user error:', errorMessage)
        return false
      }

      // Retry up to maxRetries times for network/technical errors
      if (failureCount < SIMULATION_CONFIG.maxRetries) {
        console.log(`[useSimulate] Retrying simulation (attempt ${failureCount + 1}/${SIMULATION_CONFIG.maxRetries})`)
        return true
      }

      console.log('[useSimulate] Max retries reached, giving up')
      return false
    },
    retryDelay: (attemptIndex) => {
      // Exponential backoff with configurable base and max delay
      const delay = Math.min(
        SIMULATION_CONFIG.baseDelay * Math.pow(2, attemptIndex),
        SIMULATION_CONFIG.maxDelay
      )
      console.log(`[useSimulate] Retry delay: ${delay}ms`)
      return delay
    },
    staleTime: SIMULATION_CONFIG.staleTime,
    gcTime: SIMULATION_CONFIG.gcTime,
  })

  return {
    ...simulate,
    errorMessage,
  }
}

export default useSimulate
