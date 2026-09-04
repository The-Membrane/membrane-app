import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getAtomicStatus, clearAtomicStatusCache } from '@/services/chain/atomicBatch'
import { runEvmCalls, TxRevertedError } from '@/services/chain/txRunner'
import type { EvmCall } from '@/services/chain/types'

/**
 * Load-bearing behaviors:
 *  - detection resolves 'unsupported' on every failure path (never blocks a tx)
 *    and reads both the current (atomic.status) and legacy (atomicBatch.supported)
 *    capability shapes;
 *  - a supported wallet gets ONE sendCalls submission and zero writeContract
 *    calls; an on-chain batch failure is a TxRevertedError, never a fallback;
 *  - a pre-submission sendCalls error falls back to the sequential loop, but a
 *    user rejection or any post-submission error must NOT (double-execution).
 */

const call = (name: string): EvmCall =>
  ({
    address: '0x00000000000000000000000000000000000c0ffe',
    abi: [{ type: 'function', name, stateMutability: 'nonpayable', inputs: [], outputs: [] }],
    functionName: name,
    args: [],
  } as unknown as EvmCall)

let uidCounter = 0

const atomicWallet = ({
  status = 'supported',
  batchStatus = 'success' as 'success' | 'failure',
  sendCallsError = undefined as Error | undefined,
  waitError = undefined as Error | undefined,
} = {}) => {
  const walletClient: any = {
    uid: `w${++uidCounter}`,
    chain: { id: 31337 },
    getCapabilities: vi.fn(async () => ({ 31337: { atomic: { status } } })),
    sendCalls: vi.fn(async () => {
      if (sendCallsError) throw sendCallsError
      return { id: '0xbatch' }
    }),
    waitForCallsStatus: vi.fn(async () => {
      if (waitError) throw waitError
      return { status: batchStatus, receipts: [{ transactionHash: '0xatomic' }] }
    }),
    writeContract: vi.fn(async () => '0xseq'),
  }
  const publicClient = {
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
  }
  return { walletClient, publicClient }
}

beforeEach(() => clearAtomicStatusCache())

describe('getAtomicStatus', () => {
  it("reads the current shape (atomic.status) and the 'ready' state", async () => {
    const { walletClient } = atomicWallet({ status: 'ready' })
    expect(await getAtomicStatus(walletClient, 31337)).toBe('ready')
  })

  it('reads the legacy shape (atomicBatch.supported) and hex chain keys', async () => {
    const walletClient: any = {
      uid: `w${++uidCounter}`,
      getCapabilities: vi.fn(async () => ({ '0x7a69': { atomicBatch: { supported: true } } })),
    }
    expect(await getAtomicStatus(walletClient, 31337)).toBe('supported')
  })

  it("resolves 'unsupported' for missing method, thrown request, or absent entry", async () => {
    expect(await getAtomicStatus({ uid: `w${++uidCounter}` }, 31337)).toBe('unsupported')
    const throwing: any = {
      uid: `w${++uidCounter}`,
      getCapabilities: vi.fn(async () => {
        throw new Error('4200')
      }),
    }
    expect(await getAtomicStatus(throwing, 31337)).toBe('unsupported')
    const empty: any = { uid: `w${++uidCounter}`, getCapabilities: vi.fn(async () => ({})) }
    expect(await getAtomicStatus(empty, 31337)).toBe('unsupported')
  })

  it('caches per wallet+chain — one capabilities probe', async () => {
    const { walletClient } = atomicWallet()
    await getAtomicStatus(walletClient, 31337)
    await getAtomicStatus(walletClient, 31337)
    expect(walletClient.getCapabilities).toHaveBeenCalledTimes(1)
  })
})

describe('runEvmCalls atomic path', () => {
  it('submits one batch, resolves code 0, and never touches writeContract', async () => {
    const { walletClient, publicClient } = atomicWallet()
    const onApproved = vi.fn()
    const res = await runEvmCalls({
      msgs: [call('approve'), call('depositAndBorrow')],
      address: '0xabc' as `0x${string}`,
      walletClient,
      publicClient,
      onApproved,
    })
    expect(res).toEqual({ transactionHash: '0xatomic', code: 0 })
    expect(walletClient.sendCalls).toHaveBeenCalledTimes(1)
    expect(walletClient.sendCalls.mock.calls[0][0].forceAtomic).toBe(true)
    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(onApproved).toHaveBeenCalledTimes(1)
  })

  it('REJECTS with TxRevertedError on a failed batch — no sequential retry', async () => {
    const { walletClient, publicClient } = atomicWallet({ batchStatus: 'failure' })
    await expect(
      runEvmCalls({
        msgs: [call('a'), call('b')],
        address: '0xabc' as `0x${string}`,
        walletClient,
        publicClient,
      }),
    ).rejects.toBeInstanceOf(TxRevertedError)
    expect(walletClient.writeContract).not.toHaveBeenCalled()
  })

  it('falls back to the sequential loop on a pre-submission sendCalls error', async () => {
    const { walletClient, publicClient } = atomicWallet({
      sendCallsError: new Error('Unsupported Method (4200)'),
    })
    const res = await runEvmCalls({
      msgs: [call('a'), call('b')],
      address: '0xabc' as `0x${string}`,
      walletClient,
      publicClient,
    })
    expect(res.code).toBe(0)
    expect(walletClient.writeContract).toHaveBeenCalledTimes(2)
  })

  it('does NOT fall back on user rejection', async () => {
    const { walletClient, publicClient } = atomicWallet({
      sendCallsError: new Error('User rejected the request.'),
    })
    await expect(
      runEvmCalls({
        msgs: [call('a'), call('b')],
        address: '0xabc' as `0x${string}`,
        walletClient,
        publicClient,
      }),
    ).rejects.toThrow('User rejected')
    expect(walletClient.writeContract).not.toHaveBeenCalled()
  })

  it('does NOT fall back once the batch was submitted (double-execution guard)', async () => {
    const { walletClient, publicClient } = atomicWallet({
      waitError: new Error('timeout polling wallet_getCallsStatus'),
    })
    await expect(
      runEvmCalls({
        msgs: [call('a'), call('b')],
        address: '0xabc' as `0x${string}`,
        walletClient,
        publicClient,
      }),
    ).rejects.toThrow('timeout')
    expect(walletClient.writeContract).not.toHaveBeenCalled()
  })

  it('stays sequential for a single call and for wallets without sendCalls', async () => {
    const { walletClient, publicClient } = atomicWallet()
    await runEvmCalls({
      msgs: [call('solo')],
      address: '0xabc' as `0x${string}`,
      walletClient,
      publicClient,
    })
    expect(walletClient.sendCalls).not.toHaveBeenCalled()
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1)

    const legacy: any = {
      uid: `w${++uidCounter}`,
      chain: { id: 31337 },
      writeContract: vi.fn(async () => '0xseq'),
    }
    await runEvmCalls({
      msgs: [call('a'), call('b')],
      address: '0xabc' as `0x${string}`,
      walletClient: legacy,
      publicClient,
    })
    expect(legacy.writeContract).toHaveBeenCalledTimes(2)
  })
})
