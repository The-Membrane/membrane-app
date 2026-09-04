import { describe, it, expect, vi } from 'vitest'
import { buildApproveIfNeeded } from '@/services/chain/allowance'
import { embedRouterPermits } from '@/services/chain/permit'
import { ALLOWANCE_ONLY_PERMIT } from '@/services/chain/router'
import type { EvmCall } from '@/services/chain/types'

/**
 * Two load-bearing behaviors:
 *  - buildApproveIfNeeded: an approve is emitted ONLY when the standing
 *    allowance is short (and always when the read fails — never a broadcast
 *    that reverts on transferFrom).
 *  - embedRouterPermits: [approve(router), routerCall] collapses to a single
 *    router call carrying a signed permit; EVERY failure path (no permit
 *    support, wrong spender, funds/approve mismatch, rejected signature)
 *    returns the input batch unchanged — the permit is never a gate.
 */

const ROUTER = '0x1111111111111111111111111111111111111111' as `0x${string}`
const CDP = '0x2222222222222222222222222222222222222222' as `0x${string}`
const OWNER = '0x3333333333333333333333333333333333333333' as `0x${string}`

// 65-byte signature: r = 0xaa…, s = 0xbb…, v = 27 (0x1b)
const SIGNATURE = `0x${'aa'.repeat(32)}${'bb'.repeat(32)}1b`

// supportsPermit caches per chainId:token, so each test needs a fresh token.
let tokenCounter = 0
const freshToken = (): `0x${string}` =>
  `0x${(++tokenCounter).toString(16).padStart(40, '0')}` as `0x${string}`

const readClient = (allowance: bigint | 'throws') =>
  ({
    readContract: vi.fn(async () => {
      if (allowance === 'throws') throw new Error('rpc down')
      return allowance
    }),
  } as any)

const permitClients = ({ supportsPermit = true, signRejects = false } = {}) => {
  const publicClient = {
    chain: { id: 31337 },
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'nonces') {
        if (!supportsPermit) throw new Error('no such function')
        return 0n
      }
      if (functionName === 'eip712Domain') {
        return ['0x0f', 'Token', '1', 31337n, ROUTER, `0x${'00'.repeat(32)}`, []]
      }
      throw new Error(`unexpected read: ${functionName}`)
    }),
  } as any
  const walletClient = {
    signTypedData: vi.fn(async () => {
      if (signRejects) throw new Error('User rejected the request')
      return SIGNATURE
    }),
  } as any
  return { publicClient, walletClient }
}

const approveCall = (token: `0x${string}`, spender: `0x${string}`, amount: bigint): EvmCall =>
  ({ address: token, abi: [], functionName: 'approve', args: [spender, amount] } as EvmCall)

const depositAndBorrowCall = (funds: { denom: string; amount: bigint }[]): EvmCall =>
  ({
    address: ROUTER,
    abi: [],
    functionName: 'depositAndBorrow',
    args: [0n, funds, `0x${'01'.repeat(32)}`, 100n, []],
  } as EvmCall)

const repayAndWithdrawCall = (): EvmCall =>
  ({
    address: ROUTER,
    abi: [],
    functionName: 'repayAndWithdraw',
    args: [1n, 50n, `0x${'01'.repeat(32)}`, [], ALLOWANCE_ONLY_PERMIT],
  } as EvmCall)

describe('buildApproveIfNeeded', () => {
  it('emits nothing when the standing allowance covers the amount', async () => {
    const calls = await buildApproveIfNeeded(readClient(100n), {
      token: freshToken(),
      owner: OWNER,
      spender: ROUTER,
      amount: 100n,
    })
    expect(calls).toEqual([])
  })

  it('emits the approve when the allowance is short', async () => {
    const token = freshToken()
    const calls = await buildApproveIfNeeded(readClient(99n), {
      token,
      owner: OWNER,
      spender: ROUTER,
      amount: 100n,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ address: token, functionName: 'approve' })
    expect(calls[0].args).toEqual([ROUTER, 100n])
  })

  it('emits the approve when the allowance read fails (safe default)', async () => {
    const calls = await buildApproveIfNeeded(readClient('throws'), {
      token: freshToken(),
      owner: OWNER,
      spender: ROUTER,
      amount: 100n,
    })
    expect(calls).toHaveLength(1)
  })

  it('emits nothing for a zero amount', async () => {
    const client = readClient(0n)
    const calls = await buildApproveIfNeeded(client, {
      token: freshToken(),
      owner: OWNER,
      spender: ROUTER,
      amount: 0n,
    })
    expect(calls).toEqual([])
    expect(client.readContract).not.toHaveBeenCalled()
  })
})

describe('embedRouterPermits', () => {
  it('collapses [approve(router), depositAndBorrow] into one call with a signed permit', async () => {
    const { publicClient, walletClient } = permitClients()
    const token = freshToken()
    const funds = [{ denom: `0x${'02'.repeat(32)}`, amount: 10n }]
    const out = await embedRouterPermits({
      msgs: [approveCall(token, ROUTER, 10n), depositAndBorrowCall(funds)],
      router: ROUTER,
      owner: OWNER,
      publicClient,
      walletClient,
    })
    expect(out).toHaveLength(1)
    expect(out[0].functionName).toBe('depositAndBorrow')
    const permits = (out[0].args as any[])[4]
    expect(permits).toHaveLength(1)
    expect(permits[0]).toMatchObject({ value: 10n, v: 27, r: `0x${'aa'.repeat(32)}` })
    expect(permits[0].deadline).toBeGreaterThan(0n)
  })

  it('embeds the cdtPermit for [approve(router), repayAndWithdraw]', async () => {
    const { publicClient, walletClient } = permitClients()
    const out = await embedRouterPermits({
      msgs: [approveCall(freshToken(), ROUTER, 50n), repayAndWithdrawCall()],
      router: ROUTER,
      owner: OWNER,
      publicClient,
      walletClient,
    })
    expect(out).toHaveLength(1)
    const cdtPermit = (out[0].args as any[])[4]
    expect(cdtPermit).toMatchObject({ value: 50n, v: 27 })
  })

  it('preserves a leading non-approve call (operator consent) untouched', async () => {
    const { publicClient, walletClient } = permitClients()
    const operator: EvmCall = {
      address: CDP,
      abi: [],
      functionName: 'setPositionOperator',
      args: [ROUTER, true],
    } as EvmCall
    const funds = [{ denom: `0x${'02'.repeat(32)}`, amount: 10n }]
    const out = await embedRouterPermits({
      msgs: [operator, approveCall(freshToken(), ROUTER, 10n), depositAndBorrowCall(funds)],
      router: ROUTER,
      owner: OWNER,
      publicClient,
      walletClient,
    })
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(operator)
    expect(out[1].functionName).toBe('depositAndBorrow')
  })

  it('returns the input unchanged when the token lacks permit support', async () => {
    const { publicClient, walletClient } = permitClients({ supportsPermit: false })
    const msgs = [
      approveCall(freshToken(), ROUTER, 10n),
      depositAndBorrowCall([{ denom: `0x${'02'.repeat(32)}`, amount: 10n }]),
    ]
    const out = await embedRouterPermits({ msgs, router: ROUTER, owner: OWNER, publicClient, walletClient })
    expect(out).toBe(msgs)
  })

  it('returns the input unchanged when the user rejects the signature', async () => {
    const { publicClient, walletClient } = permitClients({ signRejects: true })
    const msgs = [
      approveCall(freshToken(), ROUTER, 10n),
      depositAndBorrowCall([{ denom: `0x${'02'.repeat(32)}`, amount: 10n }]),
    ]
    const out = await embedRouterPermits({ msgs, router: ROUTER, owner: OWNER, publicClient, walletClient })
    expect(out).toBe(msgs)
  })

  it('leaves approvals to other spenders (direct Cdp path) untouched', async () => {
    const { publicClient, walletClient } = permitClients()
    const msgs = [
      approveCall(freshToken(), CDP, 10n),
      { address: CDP, abi: [], functionName: 'deposit', args: [] } as EvmCall,
    ]
    const out = await embedRouterPermits({ msgs, router: ROUTER, owner: OWNER, publicClient, walletClient })
    expect(out).toBe(msgs)
    expect(walletClient.signTypedData).not.toHaveBeenCalled()
  })

  it('bails on an approve/funds count mismatch (allowance already covered one collateral)', async () => {
    const { publicClient, walletClient } = permitClients()
    const funds = [
      { denom: `0x${'02'.repeat(32)}`, amount: 10n },
      { denom: `0x${'03'.repeat(32)}`, amount: 20n },
    ]
    const msgs = [approveCall(freshToken(), ROUTER, 10n), depositAndBorrowCall(funds)]
    const out = await embedRouterPermits({ msgs, router: ROUTER, owner: OWNER, publicClient, walletClient })
    expect(out).toBe(msgs)
    expect(walletClient.signTypedData).not.toHaveBeenCalled()
  })
})
