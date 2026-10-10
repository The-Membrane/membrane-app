import { describe, expect, it } from 'vitest'

import {
  readTwynePtExit,
  TWYNE_PT_ASSET,
  TWYNE_PT_ROUTE,
  TWYNE_PT_WRAPPER,
  type TwynePtExitClient,
} from '../../lib/carry/twynePtExit'
import { parseTwynePtExitBody } from '../../pages/api/carry/twyne-pt-exit'

const HOLDER = '0x288b523115e674fa1ac1c2315ae2874065ee7699' as const
const BLOCK_HASH = `0x${'1'.repeat(64)}` as const
const input = {
  routeKey: TWYNE_PT_ROUTE,
  destinationAddress: TWYNE_PT_WRAPPER,
  holder: HOLDER,
  assetsRaw: '1',
}

describe('Twyne PT current holder assay', () => {
  it('accepts only the frozen wrapper route and exact PT amount', () => {
    expect(parseTwynePtExitBody({ ...input, chainId: 1 })).toEqual(input)
    expect(parseTwynePtExitBody({ ...input, routeKey: 'USDe → other wrapper' })).toBeNull()
    expect(parseTwynePtExitBody({ ...input, destinationAddress: TWYNE_PT_ASSET })).toBeNull()
    expect(parseTwynePtExitBody({ ...input, assetsRaw: '0' })).toBeNull()
    expect(parseTwynePtExitBody({ ...input, assetsRaw: '1.5' })).toBeNull()
    expect(parseTwynePtExitBody({ ...input, chainId: 8453 })).toBeNull()
    expect(parseTwynePtExitBody({ ...input, extra: true })).toBeNull()
  })

  it('fails closed when the current deployment cannot be attested', async () => {
    const block = { number: 1n, hash: BLOCK_HASH, timestamp: 1_792_627_200n - 100n }
    let calls = 0
    const client = {
      getChainId: async () => 1,
      getBlock: async () => block,
      getStorageAt: async () => `0x${'0'.repeat(64)}`,
      getCode: async () => {
        calls += 1
        return '0x00'
      },
      readContract: async () => {
        throw new Error('must not read holder on unattested deployment')
      },
      call: async () => {
        throw new Error('must not simulate on unattested deployment')
      },
    } as unknown as TwynePtExitClient
    const result = await readTwynePtExit(client, input, (Number(block.timestamp) + 60) * 1000)
    expect(calls).toBe(7)
    expect(result.status).toBe('unsupported')
    expect(result.reason).toBe('deployment_unattested')
    expect(result.amountCheck).toBeUndefined()
  })

  it('rejects a stale finalized block before contract reads', async () => {
    const block = { number: 1n, hash: BLOCK_HASH, timestamp: 1_792_627_200n - 100n }
    const client = {
      getChainId: async () => 1,
      getBlock: async () => block,
    } as unknown as TwynePtExitClient
    await expect(
      readTwynePtExit(client, input, Number(block.timestamp) * 1000 + 7_200_001),
    ).rejects.toThrow('twyne_pt_exit_finalized_block_unavailable')
  })
})
