import { describe, expect, it } from 'vitest'
import type { PublicClient } from 'viem'
import { decodeFunctionResult, encodeAbiParameters, parseAbiParameters } from 'viem'

import { discoDecisionAbi, readDiscoDecisionSnapshot } from '@/lib/disco/decisionSnapshot'

const key = `0x${'ab'.repeat(32)}` as const
const otherKey = `0x${'cd'.repeat(32)}` as const
const hash = `0x${'12'.repeat(32)}` as const
const owner = '0x1111111111111111111111111111111111111111' as const
const address = '0x2222222222222222222222222222222222222222' as const
const block = { number: 50n, hash, timestamp: 1_000n }

function mockClient(
  overrides: {
    chainId?: number
    code?: string
    exists?: boolean
    intentId?: bigint
    linkedKey?: string
    active?: boolean
    drift?: boolean
    advanceFinalizedHead?: boolean
    timestamp?: bigint
  } = {},
) {
  const calls: { name: string; blockNumber?: bigint }[] = []
  const blockReads: (string | bigint)[] = []
  const codeBlocks: bigint[] = []
  let blockCalls = 0
  const client = {
    getChainId: async () => overrides.chainId ?? 31337,
    getBlock: async ({ blockTag, blockNumber }: { blockTag?: string; blockNumber?: bigint }) => {
      blockReads.push(blockTag ?? blockNumber ?? 'missing')
      blockCalls++
      const at = { ...block, timestamp: overrides.timestamp ?? block.timestamp }
      if (blockCalls === 2 && blockTag === 'finalized' && overrides.advanceFinalizedHead) {
        return { ...at, number: 51n }
      }
      return blockCalls === 2 && overrides.drift ? { ...at, hash: otherKey } : at
    },
    getCode: async ({ blockNumber }: { blockNumber: bigint }) => {
      codeBlocks.push(blockNumber)
      return overrides.code ?? '0x6000'
    },
    readContract: async ({
      functionName,
      blockNumber,
    }: {
      functionName: string
      blockNumber?: bigint
    }) => {
      calls.push({ name: functionName, blockNumber })
      if (functionName === 'config') return [0n, 0n, 0n, 604800n, 86400n, 0n, 0n, 0n, 0n]
      if (functionName === 'backingDeposits')
        return [owner, address, address, address, 50n, 0n, 0n, overrides.exists ?? true]
      if (functionName === 'depositLTVIntent') return overrides.intentId ?? 0n
      return [
        1n,
        overrides.linkedKey ?? key,
        otherKey,
        owner,
        2n,
        1n,
        30n,
        900n,
        1100n,
        1200n,
        overrides.active ?? true,
      ]
    },
  }
  return { client: client as unknown as PublicClient, calls, blockReads, codeBlocks }
}

describe('finalized LtvDisco decision snapshot', () => {
  it('decodes the actual public getter tuple positions', () => {
    const config = decodeFunctionResult({
      abi: discoDecisionAbi,
      functionName: 'config',
      data: encodeAbiParameters(
        parseAbiParameters(
          'uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256',
        ),
        [1n, 2n, 3n, 604800n, 86400n, 6n, 7n, 8n, 9n],
      ),
    })
    const deposit = decodeFunctionResult({
      abi: discoDecisionAbi,
      functionName: 'backingDeposits',
      data: encodeAbiParameters(
        parseAbiParameters('address,address,address,address,uint256,uint256,uint256,bool'),
        [owner, address, address, address, 50n, 0n, 0n, true],
      ),
    })
    expect(config[3]).toBe(604800n)
    expect(config[4]).toBe(86400n)
    expect(deposit[0]).toBe(owner)
    expect(deposit[7]).toBe(true)
  })

  it('uses deployed getter order and pins every read to one finalized block', async () => {
    const { client, calls, blockReads, codeBlocks } = mockClient({ intentId: 1n })
    const result = await readDiscoDecisionSnapshot(client, key, address)
    expect(result).toMatchObject({
      chainId: 31337,
      blockNumber: '50',
      blockHash: hash,
      blockTimestamp: '1000',
      ltvSwitchingPeriodSeconds: '604800',
      executionWindowSeconds: '86400',
      depositOwner: owner,
      intent: { id: '1', phase: 'waiting', unlockTime: '1100', expireTime: '1200' },
    })
    expect(calls.map((call) => call.name)).toEqual([
      'config',
      'backingDeposits',
      'depositLTVIntent',
      'lowerLTVIntents',
    ])
    expect(calls.every((call) => call.blockNumber === 50n)).toBe(true)
    expect(blockReads).toEqual(['finalized', 50n])
    expect(codeBlocks).toEqual([50n])
  })

  it('shows an existing deposit with no linked intent without inventing one', async () => {
    const { client, calls } = mockClient()
    expect((await readDiscoDecisionSnapshot(client, key, address)).intent).toBeNull()
    expect(calls.some((call) => call.name === 'lowerLTVIntents')).toBe(false)
  })

  it('rejects malformed and nonexistent deposits', async () => {
    const { client } = mockClient()
    await expect(
      readDiscoDecisionSnapshot(client, '0x123' as `0x${string}`, address),
    ).rejects.toMatchObject({ reason: 'deposit_missing' })
    await expect(
      readDiscoDecisionSnapshot(mockClient({ exists: false }).client, key, address),
    ).rejects.toMatchObject({ reason: 'deposit_missing' })
  })

  it('rejects the wrong chain or missing deployed code', async () => {
    await expect(
      readDiscoDecisionSnapshot(mockClient({ chainId: 1 }).client, key, address),
    ).rejects.toMatchObject({ reason: 'wrong_chain' })
    await expect(
      readDiscoDecisionSnapshot(mockClient({ code: '0x' }).client, key, address),
    ).rejects.toMatchObject({ reason: 'not_deployed' })
  })

  it('accepts a naturally advancing finalized head because the hash check is pinned', async () => {
    const { client, blockReads } = mockClient({ advanceFinalizedHead: true })
    await expect(readDiscoDecisionSnapshot(client, key, address)).resolves.toMatchObject({
      blockNumber: '50',
      blockHash: hash,
    })
    expect(blockReads).toEqual(['finalized', 50n])
  })

  it('rejects a changed pinned block and inconsistent linked intent', async () => {
    await expect(
      readDiscoDecisionSnapshot(mockClient({ drift: true }).client, key, address),
    ).rejects.toMatchObject({ reason: 'block_drift' })
    await expect(
      readDiscoDecisionSnapshot(
        mockClient({ intentId: 1n, linkedKey: otherKey }).client,
        key,
        address,
      ),
    ).rejects.toMatchObject({ reason: 'inconsistent_state' })
    await expect(
      readDiscoDecisionSnapshot(mockClient({ intentId: 1n, active: false }).client, key, address),
    ).rejects.toMatchObject({ reason: 'inconsistent_state' })
  })

  it('classifies an open or expired window from the same block timestamp', async () => {
    const waiting = mockClient({ intentId: 1n, timestamp: 1000n })
    const open = mockClient({ intentId: 1n, timestamp: 1150n })
    const expired = mockClient({ intentId: 1n, timestamp: 1201n })
    expect((await readDiscoDecisionSnapshot(waiting.client, key, address)).intent?.phase).toBe(
      'waiting',
    )
    expect((await readDiscoDecisionSnapshot(open.client, key, address)).intent?.phase).toBe(
      'executable',
    )
    expect((await readDiscoDecisionSnapshot(expired.client, key, address)).intent?.phase).toBe(
      'expired',
    )
  })
})
