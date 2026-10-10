import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readVenueState: vi.fn(),
  readDepthMarkets: vi.fn(),
}))

vi.mock('@neondatabase/serverless', () => ({ neon: () => vi.fn() }))
vi.mock('../../scripts/lib/venue-reads.mjs', () => ({
  readEnv: () => ({ get: (key: string) => (key === 'RECORDER_RPC_URL' ? 'mock-rpc' : 'mock-db') }),
  loadConfig: () => [],
  makeClient: () => ({}),
  readVenueState: mocks.readVenueState,
  readDepthMarkets: mocks.readDepthMarkets,
  primaryMetric: vi.fn(),
}))

import {
  finalizedSourceHasNotAdvanced,
  isFinalizedSource,
  readFinalizedVenueState,
} from '../../scripts/record-venue-liquidity.mjs'

const hash = `0x${'a'.repeat(64)}`
const otherHash = `0x${'b'.repeat(64)}`
const block = { number: 100n, hash, timestamp: 1_000n }

function reader(finalCheck = block, chainId = 1) {
  return {
    getChainId: vi.fn(async () => chainId),
    getBlock: vi.fn(async ({ blockTag }: { blockTag?: string }) =>
      blockTag === 'finalized' ? block : finalCheck,
    ),
  }
}

beforeEach(() => {
  mocks.readVenueState.mockReset().mockResolvedValue({
    params: { kind: 'vault' },
    instantUsd: 100,
    coolingUsd: null,
    strandedUsd: null,
  })
  mocks.readDepthMarkets.mockReset().mockResolvedValue({ depth_usd: 100 })
})

describe('finalized venue source', () => {
  it('pins all state reads to one recent finalized block and stamps its verified hash', async () => {
    const client = reader()
    const venue = { name: 'test' }
    const result = await readFinalizedVenueState(client, venue, 1_100)
    expect(client.getBlock).toHaveBeenNthCalledWith(1, { blockTag: 'finalized' })
    expect(client.getBlock).toHaveBeenNthCalledWith(2, { blockNumber: 100n })
    expect(mocks.readVenueState).toHaveBeenCalledWith(client, venue, 100n)
    expect(mocks.readDepthMarkets).toHaveBeenCalledWith(client, venue, 100n)
    expect(result.params).toMatchObject({
      depth_usd: 100,
      read_block_pinned: true,
      read_block_finalized: true,
      read_block_number: '100',
      read_block_hash: hash,
      read_block_time: 1_000,
    })
    expect(isFinalizedSource({ block: '100', params: result.params })).toBe(true)
  })

  it('rejects wrong-chain and stale sources before reading venue contracts', async () => {
    await expect(readFinalizedVenueState(reader(block, 31337), {}, 1_100)).rejects.toThrow(
      'venue_recorder_wrong_chain',
    )
    await expect(readFinalizedVenueState(reader(), {}, 8_201)).rejects.toThrow(
      'venue_recorder_stale_finalized_block',
    )
    expect(mocks.readVenueState).not.toHaveBeenCalled()
  })

  it('rejects a missing finalized hash instead of trusting an unverified block number', async () => {
    const client = {
      getChainId: vi.fn(async () => 1),
      getBlock: vi.fn(async () => ({ number: 100n, hash: null, timestamp: 1_000n })),
    }
    await expect(readFinalizedVenueState(client, {}, 1_100)).rejects.toThrow(
      'venue_recorder_invalid_finalized_block',
    )
    expect(mocks.readVenueState).not.toHaveBeenCalled()
  })

  it('rejects a block hash change instead of producing a sealed reading', async () => {
    await expect(
      readFinalizedVenueState(reader({ ...block, hash: otherHash }), {}, 1_100),
    ).rejects.toThrow('venue_recorder_block_hash_changed')
  })

  it('does not promote a latest-head or malformed prior snapshot as an event baseline', () => {
    const params = {
      read_block_pinned: true,
      read_block_finalized: true,
      read_block_number: '100',
      read_block_hash: hash,
      read_block_time: 1_000,
    }
    expect(
      isFinalizedSource({ block: '100', params: { ...params, read_block_finalized: false } }),
    ).toBe(false)
    expect(
      isFinalizedSource({ block: '100', params: { ...params, read_block_hash: '0xbad' } }),
    ).toBe(false)
    expect(
      isFinalizedSource({ block: '100', params: { ...params, read_block_number: '99' } }),
    ).toBe(false)
    expect(
      isFinalizedSource({ block: '100', params: { ...params, read_block_number: null } }),
    ).toBe(false)
    expect(finalizedSourceHasNotAdvanced({ block: '100', params }, 100n)).toBe(true)
    expect(finalizedSourceHasNotAdvanced({ block: '100', params }, 99n)).toBe(true)
    expect(finalizedSourceHasNotAdvanced({ block: '100', params }, 101n)).toBe(false)
    expect(
      finalizedSourceHasNotAdvanced(
        { block: '100', params: { ...params, read_block_finalized: false } },
        99n,
      ),
    ).toBe(false)
  })
})
