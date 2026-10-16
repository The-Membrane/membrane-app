// lib/position-exec/simulate.ts and revert.ts — the fallback simulation (one call at a time,
// the in-batch allowance rule) and revert naming. The eth_simulateV1 path runs against
// mainnet in scripts/position/lever-exec-ethcall.ts.

import { describe, expect, it } from 'vitest'
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  HttpRequestError,
  UserRejectedRequestError,
  type PublicClient,
} from 'viem'

import { aavePoolAbi } from '@/lib/position-exec/abis'
import { leverCalls } from '@/lib/position-exec/builders'
import { isUserRejection, namedRevert, revertReason } from '@/lib/position-exec/revert'
import {
  GAS_BUFFER_PCT,
  buffered,
  hasEarlierApprove,
  simulateLever,
} from '@/lib/position-exec/simulate'

const OWNER = '0x7ada000000000000000000000000000000d14200' as const
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const
const POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2' as const
const CALLS = leverCalls(
  { venue: 'aave', kind: 'repay', pool: POOL, asset: USDC, amount: 460_000_000n, owner: OWNER },
  0n,
)

const reverted = (message: string) =>
  new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: aavePoolAbi, functionName: 'repay', message }),
    {
      abi: aavePoolAbi,
      functionName: 'repay',
      args: [USDC, 460_000_000n, 2n, OWNER],
      contractAddress: POOL,
    },
  )

/** No eth_simulateV1 anywhere (request throws), so simulateLever falls back to eth_call. */
function fallbackClient(onCall: (functionName: string) => bigint | Error): PublicClient {
  return {
    request: async () => {
      throw new Error('the method eth_simulateV1 does not exist/is not available')
    },
    simulateContract: async ({ functionName }: { functionName: string }) => {
      const r = onCall(functionName)
      if (r instanceof Error) throw r
      return { result: undefined }
    },
    estimateContractGas: async ({ functionName }: { functionName: string }) =>
      onCall(functionName) as bigint,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 2_000_000_000n }),
  } as unknown as PublicClient
}

describe('the fallback simulation', () => {
  it('accepts an action whose only failure is the allowance its own approve grants, gas unknown', async () => {
    const r = await simulateLever(
      fallbackClient((fn) =>
        fn === 'approve' ? 55_570n : reverted('ERC20: transfer amount exceeds allowance'),
      ),
      OWNER,
      CALLS,
    )
    expect(r).toEqual({
      ok: true,
      method: 'eth_call',
      gas: [55_570n, null],
      bufferedGas: buffered(55_570n),
      maxFeePerGas: 2_000_000_000n,
    })
  })
  it('stops at any other revert, naming the step and the reason', async () => {
    const r = await simulateLever(
      fallbackClient((fn) => (fn === 'approve' ? 55_570n : reverted('29'))),
      OWNER,
      CALLS,
    )
    expect(r).toEqual({ ok: false, method: 'eth_call', step: 1, reason: '29' })
  })
  it('does not excuse an allowance revert with no approve before it', async () => {
    const alone = CALLS.slice(1)
    const r = await simulateLever(
      fallbackClient(() => reverted('ERC20: transfer amount exceeds allowance')),
      OWNER,
      alone,
    )
    expect(r).toMatchObject({ ok: false, step: 0 })
    expect(hasEarlierApprove(CALLS, 1)).toBe(true)
    expect(hasEarlierApprove(CALLS, 0)).toBe(false)
  })
  it('throws on a transport failure rather than calling it a revert', async () => {
    const http = new HttpRequestError({ url: 'https://rpc', details: 'timeout' })
    await expect(
      simulateLever(
        fallbackClient(() => http),
        OWNER,
        CALLS,
      ),
    ).rejects.toThrow(/simulation failed on every RPC path/)
  })
  it("buffers gas by the pipeline's 5%", () => {
    expect(GAS_BUFFER_PCT).toBe(105n)
    expect(buffered(200_000n)).toBe(210_000n)
  })
})

describe('reverts, named', () => {
  it("pulls the contract's own reason out of viem's wrapping", () => {
    expect(revertReason(reverted('51'))).toBe('51')
  })
  it('names Aave codes and custom errors, Comet errors and ERC-20 shortfalls; leaves the rest verbatim', () => {
    expect(namedRevert('51', 'aave')).toBe('Supply cap reached (51)')
    expect(namedRevert('ReservePaused', 'aave')).toBe('Reserve is paused (ReservePaused)')
    expect(namedRevert('39', 'aave')).toBe('No variable-rate debt to repay (39)')
    expect(namedRevert('SupplyCapExceeded', 'compound')).toBe(
      'Supply cap reached (SupplyCapExceeded)',
    )
    expect(namedRevert('Paused', 'compound')).toBe('Supply is paused on this Comet (Paused)')
    expect(namedRevert('ERC20: transfer amount exceeds balance', 'morpho')).toBe(
      'Balance too low (ERC20: transfer amount exceeds balance)',
    )
    expect(namedRevert('51', 'morpho')).toBe('51')
    expect(namedRevert('inconsistent input', 'morpho')).toBe('inconsistent input')
  })
  it('recognises a wallet rejection however it is wrapped', () => {
    expect(
      isUserRejection(new UserRejectedRequestError(new Error('User rejected the request.'))),
    ).toBe(true)
    expect(isUserRejection({ code: 4001, message: 'nope' })).toBe(true)
    expect(isUserRejection(reverted('51'))).toBe(false)
  })
})
