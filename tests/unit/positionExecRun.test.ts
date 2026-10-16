// lib/position-exec/run.ts — the lever runner on fake clients: a slow receipt keeps being
// watched, a replaced transaction is not a settlement, 'ready' (EIP-7702) never batches,
// and a partial run names the approval it left standing.

import { describe, expect, it } from 'vitest'
import { WaitForTransactionReceiptTimeoutError, type Hash } from 'viem'

import { leverCalls } from '@/lib/position-exec/builders'
import {
  RunStopped,
  batchesAtomically,
  runLever,
  standingApproval,
  type RunEvent,
  type RunPublic,
  type RunWallet,
} from '@/lib/position-exec/run'

const OWNER = '0x7ada000000000000000000000000000000d14200' as const
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const
const POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2' as const
const CALLS = leverCalls(
  { venue: 'aave', kind: 'repay', pool: POOL, asset: USDC, amount: 460_000_000n, owner: OWNER },
  0n,
)
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hash

function wallet(o: Partial<RunWallet> = {}): RunWallet & { sent: string[] } {
  const sent: string[] = []
  let n = 0
  return {
    sent,
    chain: { id: 1 },
    writeContract: async (a) => {
      sent.push(String(a.functionName))
      return h(++n)
    },
    ...o,
  }
}

describe('runLever', () => {
  it('runs one call at a time and settles on the last hash', async () => {
    const w = wallet()
    const events: RunEvent[] = []
    const client: RunPublic = {
      waitForTransactionReceipt: async ({ hash }) => ({ status: 'success', transactionHash: hash }),
    }
    const out = await runLever({
      calls: CALLS,
      owner: OWNER,
      wallet: w,
      client,
      atomicStatus: 'unsupported',
      emit: (e) => events.push(e),
    })
    expect(out).toEqual({ kind: 'settled', hash: h(2) })
    expect(w.sent).toEqual(['approve', 'repay'])
    expect(events[0]).toEqual({ type: 'path', atomic: false, total: 2 })
  })
  it('keeps watching the same hash after viem times out', async () => {
    let tries = 0
    const events: RunEvent[] = []
    const client: RunPublic = {
      waitForTransactionReceipt: async ({ hash }) => {
        if (++tries <= 2) throw new WaitForTransactionReceiptTimeoutError({ hash })
        return { status: 'success', transactionHash: hash }
      },
    }
    const out = await runLever({
      calls: CALLS.slice(1),
      owner: OWNER,
      wallet: wallet(),
      client,
      atomicStatus: 'unsupported',
      emit: (e) => events.push(e),
    })
    expect(out.kind).toBe('settled')
    expect(events.filter((e) => e.type === 'waiting')).toEqual([
      { type: 'waiting', hash: h(1) },
      { type: 'waiting', hash: h(1) },
    ])
  })
  it('stops watching once the slip is gone', async () => {
    const client: RunPublic = {
      waitForTransactionReceipt: async ({ hash }) => {
        throw new WaitForTransactionReceiptTimeoutError({ hash })
      },
    }
    await expect(
      runLever({
        calls: CALLS.slice(1),
        owner: OWNER,
        wallet: wallet(),
        client,
        atomicStatus: 'unsupported',
        emit: () => {},
        alive: () => false,
      }),
    ).rejects.toBeInstanceOf(RunStopped)
  })
  it('a cancelled or replaced call did not happen; a repriced one is the same call', async () => {
    const replacing = (reason: 'cancelled' | 'replaced' | 'repriced'): RunPublic => ({
      waitForTransactionReceipt: async ({ hash, onReplaced }) => {
        if (hash === h(2)) {
          onReplaced?.({ reason, transaction: { hash: h(99) } })
          return { status: 'success', transactionHash: h(99) }
        }
        return { status: 'success', transactionHash: hash }
      },
    })
    for (const reason of ['cancelled', 'replaced'] as const) {
      const out = await runLever({
        calls: CALLS,
        owner: OWNER,
        wallet: wallet(),
        client: replacing(reason),
        atomicStatus: 'unsupported',
        emit: () => {},
      })
      expect(out).toEqual({ kind: 'replaced', hash: h(99), index: 1, landed: 1 })
    }
    const repriced = await runLever({
      calls: CALLS,
      owner: OWNER,
      wallet: wallet(),
      client: replacing('repriced'),
      atomicStatus: 'unsupported',
      emit: () => {},
    })
    expect(repriced).toEqual({ kind: 'settled', hash: h(99) })
  })
  it("batches only when the wallet says 'supported'; 'ready' (an EIP-7702 upgrade) runs call by call", async () => {
    expect(batchesAtomically('supported', 2)).toBe(true)
    expect(batchesAtomically('ready', 2)).toBe(false)
    expect(batchesAtomically('supported', 1)).toBe(false)
    let batched = false
    const w = wallet({ sendCalls: async () => ((batched = true), { id: 'b' }) })
    const client: RunPublic = {
      waitForTransactionReceipt: async ({ hash }) => ({ status: 'success', transactionHash: hash }),
    }
    await runLever({
      calls: CALLS,
      owner: OWNER,
      wallet: w,
      client,
      atomicStatus: 'ready',
      emit: () => {},
    })
    expect(batched).toBe(false)
    expect(w.sent).toEqual(['approve', 'repay'])
  })
  it('an off-chain batch failure spends no gas; a mined one does', async () => {
    const run = (receipts: { transactionHash: Hash }[]) =>
      runLever({
        calls: CALLS,
        owner: OWNER,
        wallet: wallet({
          sendCalls: async () => ({ id: 'b' }),
          waitForCallsStatus: async () => ({ status: 'failure', receipts }),
        }),
        client: {
          waitForTransactionReceipt: async () => ({ status: 'success', transactionHash: h(1) }),
        },
        atomicStatus: 'supported',
        emit: () => {},
      })
    expect(await run([])).toMatchObject({ kind: 'reverted', gasSpent: false })
    expect(await run([{ transactionHash: h(5) }])).toMatchObject({
      kind: 'reverted',
      gasSpent: true,
      hash: h(5),
    })
  })
  it('reports what landed when the wallet declines the second call', async () => {
    let n = 0
    const w = wallet({
      writeContract: async () => {
        if (++n === 2) throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
        return h(n)
      },
    })
    const client: RunPublic = {
      waitForTransactionReceipt: async ({ hash }) => ({ status: 'success', transactionHash: hash }),
    }
    const err = await runLever({
      calls: CALLS,
      owner: OWNER,
      wallet: w,
      client,
      atomicStatus: 'unsupported',
      emit: () => {},
    }).catch((e) => e)
    expect(err).toBeInstanceOf(RunStopped)
    expect(err.landed).toBe(1)
  })
})

describe('standingApproval', () => {
  it('is the approve that landed before an action that did not', () => {
    expect(standingApproval(CALLS, 1)).toBe(460_000_000n)
    expect(standingApproval(CALLS, 0)).toBeNull()
    expect(standingApproval(CALLS, 2)).toBeNull()
    const zeroFirst = leverCalls(
      { venue: 'aave', kind: 'repay', pool: POOL, asset: USDC, amount: 2n, owner: OWNER },
      1n,
    )
    expect(standingApproval(zeroFirst, 1)).toBeNull() // only the reset to 0 landed
    expect(standingApproval(zeroFirst, 2)).toBe(2n)
  })
})
