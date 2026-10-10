import { describe, expect, it, vi } from 'vitest'

import {
  HASTRA_STAKING_VAULT,
  HASTRA_YIELD_VAULT,
  PYUSD_TOKEN,
  USDC_TOKEN,
  readPyusdStakingRouteIdentity,
  type PyusdStakingIdentityClient,
} from '@/lib/carry/pyusdStakingRouteIdentity'

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  const hashes: Record<string, `0x${string}`> = {
    '0x6001': '0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6',
    '0x6002': '0x0e8044f306a768cfd365491bfb983ed4415c56263156d9a1a40b1341e56c4cae',
    '0x6003': '0x38dcc95686d703a0a5fa9f9cd707c5cdcc077879b5c60c0d63e4ff9264067851',
  }
  return { ...actual, keccak256: (code: `0x${string}`) => hashes[code] ?? actual.keccak256(code) }
})

const blockHash = `0x${'a'.repeat(64)}` as const
const block = { number: 26093978n, hash: blockHash, timestamp: 1790815703n }
const stakingImplementation = '0x881fe0e5e91c54fabbf0198a1bb2fc6e5747d4c5'
const yieldImplementation = '0x06e0b9155a3cf07f41ac826ccfee7ef8413a9723'
const slot = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`

function client(options: { stakingAsset?: string; usdcDecimals?: number; drift?: boolean } = {}) {
  return {
    getChainId: vi.fn().mockResolvedValue(1),
    getBlock: vi.fn().mockResolvedValue(block),
    getStorageAt: vi
      .fn()
      .mockImplementation(({ address }) =>
        Promise.resolve(
          slot(address === HASTRA_STAKING_VAULT ? stakingImplementation : yieldImplementation),
        ),
      ),
    getCode: vi
      .fn()
      .mockImplementation(({ address }) =>
        Promise.resolve(
          options.drift
            ? '0x6000'
            : address === stakingImplementation
              ? '0x6002'
              : address === yieldImplementation
                ? '0x6003'
                : '0x6001',
        ),
      ),
    readContract: vi.fn().mockImplementation(({ address, functionName }) => {
      if (functionName === 'asset')
        return Promise.resolve(
          address === HASTRA_STAKING_VAULT
            ? (options.stakingAsset ?? HASTRA_YIELD_VAULT)
            : USDC_TOKEN,
        )
      if (functionName === 'decimals')
        return Promise.resolve(address === USDC_TOKEN ? (options.usdcDecimals ?? 6) : 6)
      throw new Error(`unexpected_${functionName}_${address}`)
    }),
  }
}

describe('PYUSD frozen StakingVault route identity', () => {
  it('reports only the verified asset links without a holder or payout claim', async () => {
    const mock = client()
    const result = await readPyusdStakingRouteIdentity(
      mock as unknown as PyusdStakingIdentityClient,
      1790815703_000,
    )
    expect(result.status).toBe('route_asset_mismatch')
    expect(result.reason).toBe('pyusd_leg_not_verified')
    expect(result.evidence.stakingAsset?.toLowerCase()).toBe(HASTRA_YIELD_VAULT)
    expect(result.evidence.yieldAsset?.toLowerCase()).toBe(USDC_TOKEN)
    expect(result.evidence.stakingAssetDecimals).toBe(6)
    expect(result.evidence.yieldAssetDecimals).toBe(6)
    expect(result.assetLinks).toBe('staking_asset_wYLDS_yield_asset_USDC')
    expect(result).not.toHaveProperty('exitPath')
    expect(result.pyusdPayout).toBe('not_attested')
    expect(result.holderAmountCheck).toBe('not_performed_route_incomplete')
    expect(JSON.stringify(result)).not.toContain('holderAddress')
    expect(mock.getStorageAt).toHaveBeenCalledWith(
      expect.objectContaining({ blockHash, requireCanonical: true }),
    )
    expect(mock.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: PYUSD_TOKEN, functionName: 'decimals', blockHash }),
    )
    expect(mock.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: USDC_TOKEN, functionName: 'decimals', blockHash }),
    )
  })

  it('fails closed before asset reads when deployment code drifts', async () => {
    const mock = client({ drift: true })
    const result = await readPyusdStakingRouteIdentity(
      mock as unknown as PyusdStakingIdentityClient,
      1790815703_000,
    )
    expect(result).toMatchObject({ status: 'unsupported', reason: 'deployment_unattested' })
    expect(mock.readContract).not.toHaveBeenCalled()
  })

  it('does not preserve the mismatch verdict after asset identity changes', async () => {
    const result = await readPyusdStakingRouteIdentity(
      client({ stakingAsset: PYUSD_TOKEN }) as unknown as PyusdStakingIdentityClient,
      1790815703_000,
    )
    expect(result).toMatchObject({ status: 'unsupported', reason: 'identity_changed' })
  })

  it('checks USDC token decimals rather than only the yield vault share decimals', async () => {
    const result = await readPyusdStakingRouteIdentity(
      client({ usdcDecimals: 18 }) as unknown as PyusdStakingIdentityClient,
      1790815703_000,
    )
    expect(result.evidence.yieldShareDecimals).toBe(6)
    expect(result.evidence.yieldAssetDecimals).toBe(18)
    expect(result).toMatchObject({ status: 'unsupported', reason: 'identity_changed' })
  })
})
