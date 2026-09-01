import { describe, it, expect, vi } from 'vitest'
import { runEvmCalls, TxRevertedError } from '@/services/chain/txRunner'
import type { EvmCall } from '@/services/chain/types'

/**
 * The revert path is the load-bearing behavior here: a mined-but-reverted call must
 * REJECT so react-query takes onError (danger toast, modal stays open) and never
 * onSuccess. The old implementation returned { code: 1 } on revert, which rendered
 * a success-styled "Transaction Failed" toast and closed the modal
 * (tools/ui-sensory/FINDINGS.md). These tests pin the contract.
 */

const call = (name: string): EvmCall =>
  ({ address: '0xc0ffee', abi: [], functionName: name, args: [] } as unknown as EvmCall)

const clients = (receipts: Array<'success' | 'reverted'>) => {
  let n = 0
  const hashes: string[] = []
  const walletClient = {
    chain: { id: 31337 },
    writeContract: vi.fn(async () => {
      const h = `0xhash${n++}` as `0x${string}`
      hashes.push(h)
      return h
    }),
  }
  const publicClient = {
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: string }) => ({
      status: receipts[hashes.indexOf(hash)],
    })),
  }
  return { walletClient, publicClient, hashes }
}

describe('runEvmCalls', () => {
  it('resolves code 0 with the last hash when every call succeeds', async () => {
    const { walletClient, publicClient } = clients(['success', 'success'])
    const onApproved = vi.fn()
    const res = await runEvmCalls({
      msgs: [call('a'), call('b')],
      address: '0xabc' as `0x${string}`,
      walletClient,
      publicClient,
      onApproved,
    })
    expect(res).toEqual({ transactionHash: '0xhash1', code: 0 })
    expect(onApproved).toHaveBeenCalledTimes(2)
  })

  it('REJECTS with TxRevertedError when the receipt is reverted — never resolves code 1', async () => {
    const { walletClient, publicClient } = clients(['reverted'])
    const p = runEvmCalls({
      msgs: [call('a')],
      address: '0xabc' as `0x${string}`,
      walletClient,
      publicClient,
    })
    await expect(p).rejects.toBeInstanceOf(TxRevertedError)
    await expect(p).rejects.toMatchObject({
      transactionHash: '0xhash0',
      callIndex: 0,
      totalCalls: 1,
    })
    await expect(p).rejects.toThrow('Transaction reverted on-chain. Your position is unchanged.')
  })

  it('names the failing step when a later call of a batch reverts', async () => {
    const { walletClient, publicClient } = clients(['success', 'reverted'])
    const p = runEvmCalls({
      msgs: [call('approve'), call('deposit')],
      address: '0xabc' as `0x${string}`,
      walletClient,
      publicClient,
    })
    await expect(p).rejects.toMatchObject({ callIndex: 1, totalCalls: 2 })
    await expect(p).rejects.toThrow('Transaction reverted on step 2 of 2')
  })

  it('stops the batch at the reverted call — later calls are never signed', async () => {
    const { walletClient, publicClient } = clients(['reverted', 'success'])
    await expect(
      runEvmCalls({
        msgs: [call('a'), call('b')],
        address: '0xabc' as `0x${string}`,
        walletClient,
        publicClient,
      }),
    ).rejects.toBeInstanceOf(TxRevertedError)
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1)
  })
})
