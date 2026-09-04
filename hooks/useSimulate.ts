import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatEther } from 'viem'
import useWallet from './useWallet'
import type { EvmCall, EvmFeeEstimate } from '@/services/chain/types'

// Configuration for retry behavior
const SIMULATION_CONFIG = {
  maxRetries: 3,
  baseDelay: 1000, // 1 second
  maxDelay: 10000, // 10 seconds
  staleTime: 15000, // 15 seconds
  gcTime: 60000, // 1 minute
  gasBufferMultiplier: 1.05, // 5% buffer, carried over from the Cosmos pipeline
} as const

// Errors that are the user's to fix — retrying only re-prompts the same failure
const USER_ERROR_PATTERNS = [
  'insufficient funds',
  'user rejected',
  'user denied',
  'request rejected',
  'execution reverted', // contract revert: deterministic, retry won't help
  'unauthorized',
]

const isUserError = (message: string) =>
  USER_ERROR_PATTERNS.some((p) => message.toLowerCase().includes(p))

// Revert reasons that mean "the standing allowance is short" — expected for a
// call whose approve lands earlier in the SAME batch, since each call is
// simulated against current chain state (the approve is not applied yet).
const ALLOWANCE_ERROR_PATTERNS = [
  'insufficient allowance',
  'erc20insufficientallowance',
  'transfer amount exceeds allowance',
]

const isAllowanceError = (message: string) =>
  ALLOWANCE_ERROR_PATTERNS.some((p) => message.toLowerCase().includes(p))

// Display-only gas stand-in for a call whose real estimate is blocked by a
// pending in-batch approve. Never forwarded to the wallet: a batch with an
// approve has length > 1, and txRunner only forwards gas for single-call
// batches — the wallet re-estimates each call after the approve has landed.
const DEPENDENT_CALL_GAS_FALLBACK = 800_000n

type Simulate = {
  msgs: EvmCall[] | undefined | null
  amount: string | undefined
  enabled?: boolean
  queryKey?: string[]
  /** legacy param, ignored — chain comes from the wagmi account context */
  chain_id?: string
}

/**
 * Fee estimation + revert pre-flight — EVM internals behind the same hook shape the
 * CTA pipeline has always used. Was: cosmos-kit estimateFee + StargateClient.simulate.
 *
 * data shape: [EvmFeeEstimate, totalGasUnits] (was [StdFee, simulatedGas]).
 * viem's simulateContract both validates the call (revert = throw with decoded reason)
 * and estimates; EIP-1559 fee params come from estimateFeesPerGas.
 */
const useSimulate = ({ msgs, amount, enabled = false, queryKey = [] }: Simulate) => {
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const { isWalletConnected, address, chain, publicClient } = useWallet()

  // clear error message when amount is changed
  useEffect(() => {
    if (amount === '' && !!errorMessage) setErrorMessage(null)
  }, [amount, errorMessage])

  const simulate = useQuery<[EvmFeeEstimate, number] | undefined, Error>({
    queryKey: ['simulate', amount, address, chain.id, ...queryKey],
    queryFn: async () => {
      if (!enabled || !isWalletConnected || !address || !publicClient) return undefined
      if (!msgs || msgs.length === 0) return undefined

      try {
        setErrorMessage(null)

        // Pre-flight each call (throws with decoded revert reason) and sum gas.
        // Calls are simulated against CURRENT chain state, concurrently — a later
        // call never sees an earlier call's effect. The one real dependency in our
        // batches is approve → action: the action's transferFrom reverts in
        // simulation until the approve lands. That exact case is tolerated below
        // (allowance revert + an earlier in-batch approve whose spender is the
        // failing call's target) with a display-only gas fallback; every other
        // failure still throws. simulateContract runs before estimateContractGas
        // *within* a call (decoded reason beats a raw estimate error), and results
        // are walked back in original array order so the first call (by index, not
        // network timing) wins when more than one would fail.
        const approveSpenders = new Map<number, string>()
        msgs.forEach((call, idx) => {
          if (call.functionName === 'approve' && call.args?.length === 2) {
            approveSpenders.set(idx, String(call.args[0]).toLowerCase())
          }
        })
        const hasEarlierApproveFor = (target: string, callIdx: number) => {
          for (const [idx, spender] of approveSpenders) {
            if (idx < callIdx && spender === target.toLowerCase()) return true
          }
          return false
        }

        const callResults = await Promise.all(
          msgs.map(async (call, callIdx) => {
            try {
              await publicClient.simulateContract({
                address: call.address,
                abi: call.abi,
                functionName: call.functionName,
                args: call.args as any,
                value: call.value,
                account: address,
              })
              const gas = await publicClient.estimateContractGas({
                address: call.address,
                abi: call.abi,
                functionName: call.functionName,
                args: call.args as any,
                value: call.value,
                account: address,
              })
              return { gas }
            } catch (err: any) {
              const msg: string = err?.shortMessage ?? err?.message ?? String(err)
              if (isAllowanceError(msg) && hasEarlierApproveFor(call.address, callIdx)) {
                return { gas: DEPENDENT_CALL_GAS_FALLBACK }
              }
              return { err }
            }
          })
        )

        let totalGas = 0n
        for (const result of callResults) {
          if ('err' in result) throw result.err
          totalGas += result.gas as bigint
        }

        const bufferedGas =
          (totalGas * BigInt(Math.round(SIMULATION_CONFIG.gasBufferMultiplier * 100))) / 100n

        const { maxFeePerGas } = await publicClient.estimateFeesPerGas()
        const totalWei = bufferedGas * (maxFeePerGas ?? 0n)

        const fee: EvmFeeEstimate = {
          gas: bufferedGas,
          maxFeePerGas: maxFeePerGas ?? 0n,
          totalWei,
          totalFormatted: `${Number(formatEther(totalWei)).toPrecision(3)} ETH`,
        }

        return [fee, Number(totalGas)]
      } catch (err: any) {
        const msg: string = err?.shortMessage ?? err?.message ?? String(err)
        console.error('[useSimulate] simulation failed:', msg)
        setErrorMessage(msg)
        throw err
      }
    },
    enabled: enabled && (msgs?.length || 0) > 0 && isWalletConnected,
    retry: (failureCount, error) => {
      const message = error?.message || String(error)
      if (isUserError(message)) return false
      return failureCount < SIMULATION_CONFIG.maxRetries
    },
    retryDelay: (attemptIndex) =>
      Math.min(SIMULATION_CONFIG.baseDelay * Math.pow(2, attemptIndex), SIMULATION_CONFIG.maxDelay),
    staleTime: SIMULATION_CONFIG.staleTime,
    gcTime: SIMULATION_CONFIG.gcTime,
  })

  return {
    ...simulate,
    errorMessage,
  }
}

export default useSimulate
