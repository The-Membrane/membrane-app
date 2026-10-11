import type { PublicClient } from 'viem'
import { describe, expect, it } from 'vitest'

import { parsePools, SourceError } from '@/lib/carryScan/sources'
import type { Candidate, LlamaPool, MorphoVaultInfo } from '@/lib/carryScan/types'
import { STABLES_CONFIG } from '@/lib/carryScan/universe'
import {
  aavePoolOf,
  matchMorphoVault,
  resolveAddress,
  trailing7dApy,
  verifyOnChain,
  withinTvl,
} from '@/lib/carryScan/verify'
import { AAVE_V3_POOL } from '@/lib/netApy/venues'

const USDC = STABLES_CONFIG.stables.find((s) => s.symbol === 'USDC')!
const GHO = STABLES_CONFIG.stables.find((s) => s.symbol === 'GHO')!
const cand = (p: Partial<LlamaPool>, stable = USDC): Candidate => ({
  pool: {
    pool: 'u',
    chain: 'Ethereum',
    project: 'aave-v3',
    symbol: 'USDC',
    tvlUsd: 50e6,
    apy: 5,
    apyBase: 5,
    apyReward: null,
    apyMean30d: 5,
    stablecoin: true,
    exposure: 'single',
    ilRisk: 'no',
    poolMeta: null,
    count: 100,
    outlier: false,
    underlyingTokens: [stable.address],
    ...p,
  },
  stables: [stable],
  category: 'Lending',
  flags: [],
  exposure: 'single',
})

describe('address resolution', () => {
  it('maps Aave Core/Prime and Spark reserve rows to their Pool, and only when the row IS the reserve', () => {
    expect(aavePoolOf(cand({}))).toEqual({ pool: AAVE_V3_POOL, kind: 'aave-reserve' })
    expect(aavePoolOf(cand({ poolMeta: 'Prime Instance' }))?.pool).toBe(
      '0x4e033931ad43597d96D6bcc25c280717730B58B1',
    )
    expect(aavePoolOf(cand({ poolMeta: 'Aave Horizon Market' }))).toBeNull()
    // Aave's sGHO savings row has GHO underneath but is not the GHO reserve (2026-10-10 dry run).
    expect(aavePoolOf(cand({ symbol: 'SGHO' }, GHO))).toBeNull()
  })

  it('matches a Morpho vault by asset and symbol; TVL breaks a tie; an ambiguous match stays unresolved', () => {
    const v = (address: string, symbol: string, tvl: number): MorphoVaultInfo => ({
      address,
      symbol,
      name: symbol,
      assetAddress: USDC.address,
      version: 'v2',
      netApy: 0.05,
      netApyExcludingRewards: 0.045,
      fee: 0.1,
      totalAssetsUsd: tvl,
    })
    const c = cand({ project: 'morpho-blue', symbol: 'STEAKUSDC', tvlUsd: 100e6 })
    expect(matchMorphoVault(c, [v('0xa', 'steakUSDC', 100e6)])).toMatchObject({ address: '0xa' })
    expect(
      matchMorphoVault(c, [v('0xa', 'steakUSDC', 100e6), v('0xb', 'steakUSDC', 60e6)]),
    ).toMatchObject({ address: '0xa' })
    expect(
      matchMorphoVault(c, [v('0xa', 'steakUSDC', 99e6), v('0xb', 'steakUSDC', 101e6)]),
    ).toEqual({ ambiguous: 2 })
  })

  it('never guesses: a project with no resolver is unresolved with the reason', async () => {
    const r = await resolveAddress(cand({ project: 'sentora-curator', symbol: 'USDC' }), {
      poolAddresses: {},
      morphoVaults: [],
      aTokenOf: async () => null,
    })
    expect(r.address).toBeNull()
    expect('reason' in r && r.reason).toMatch(/poolAddresses\.json/)
  })
})

describe('on-chain checks', () => {
  const anchor = {
    chainId: 1 as const,
    blockNumber: 26_163_807n,
    blockTimestamp: 1_791_657_000n,
    blockHash: '0x01' as `0x${string}`,
  }
  const fakeClient = (o: {
    code?: string
    asset?: string
    totalAssets?: bigint
    prev?: bigint
    now?: bigint
    /** Seconds the 50,400 blocks behind the anchor span (block timestamps); 7 days by default. */
    spanSec?: number
    getBlockFails?: boolean
  }) =>
    ({
      getCode: async () => o.code ?? '0x6000',
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
        if (o.getBlockFails) throw new Error('header not found https://rpc.example/key')
        return {
          number: blockNumber,
          timestamp:
            blockNumber === anchor.blockNumber
              ? anchor.blockTimestamp
              : anchor.blockTimestamp - BigInt(o.spanSec ?? 7 * 86_400),
        }
      },
      readContract: async ({
        functionName,
        blockNumber,
      }: {
        functionName: string
        blockNumber: bigint
      }) => {
        if (functionName === 'asset') return o.asset ?? USDC.address
        if (functionName === 'totalAssets') return o.totalAssets ?? 50_000_000n * 10n ** 6n
        if (functionName === 'decimals') return 6
        if (functionName === 'convertToAssets')
          return blockNumber === anchor.blockNumber ? (o.now ?? 1_001_000n) : (o.prev ?? 1_000_000n)
        throw new Error(`unexpected ${functionName}`)
      },
    }) as unknown as PublicClient
  const input = {
    address: '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33',
    kind: 'erc4626' as const,
    stable: USDC,
    suppliedUsd: 50e6,
    apyBase7dPct: 5.3,
    apyBasePct: 5.3,
  }

  it('passes code, asset, TVL and the trailing 7-day cross-check', async () => {
    const r = await verifyOnChain(fakeClient({}), anchor, input)
    expect(r).toMatchObject({
      ok: true,
      checks: ['code', 'asset', 'tvl', 'trailing-7d vs apyBase7d'],
      sourceDisagreement: false,
    })
    expect(r.trailing7dApy).toBeCloseTo(trailing7dApy(1_000_000n, 1_001_000n)!, 12)
  })

  it('annualises the 7-day growth over the real time span of its blocks (block timestamps)', async () => {
    // 2026-10-11 refuter: the 50,400 blocks behind anchor 26,169,675 spanned 7.025 days, not 7.
    // Annualising over a nominal 7 days overstated the figure (5.625% vs about 5.605%), and the
    // figure now feeds the averaged venue APY.
    const span = 7.025 * 86_400
    const r = await verifyOnChain(fakeClient({ spanSec: span }), anchor, input)
    const expected = (1_001_000 / 1_000_000) ** ((365 * 86_400) / span) - 1
    expect(r.trailing7dApy).toBeCloseTo(expected, 12)
    const nominal = (1_001_000 / 1_000_000) ** (365 / 7) - 1
    expect(r.trailing7dApy!).toBeLessThan(nominal)
  })

  it('a block-timestamp read that fails leaves no 7-day figure (listed as failed), not a failed row', async () => {
    const r = await verifyOnChain(fakeClient({ getBlockFails: true }), anchor, input)
    expect(r.ok).toBe(true)
    expect(r.trailing7dApy).toBeNull()
    expect(r.trailing7dError).toMatch(/7-day share-price read failed/)
    expect(r.trailing7dError).not.toContain('rpc.example')
  })

  it('fails closed on missing code, a wrong asset, or TVL more than 15% off', async () => {
    expect((await verifyOnChain(fakeClient({ code: '0x' }), anchor, input)).failed).toMatch(
      /no contract code/,
    )
    expect(
      (
        await verifyOnChain(
          fakeClient({ asset: '0xdAC17F958D2ee523a2206206994597C13D831ec7' }),
          anchor,
          input,
        )
      ).failed,
    ).toMatch(/is not USDC/)
    expect(
      (await verifyOnChain(fakeClient({ totalAssets: 20_000_000n * 10n ** 6n }), anchor, input))
        .failed,
    ).toMatch(/not within ±15%/)
    expect(withinTvl(115, 100)).toBe(true)
    expect(withinTvl(116, 100)).toBe(false)
  })

  it('marks a source disagreement (a flag, not a failure) when 7-day growth is > 1pp from apyBase7d', async () => {
    const r = await verifyOnChain(fakeClient({ now: 1_003_000n }), anchor, input) // ~16.9% trailing vs 5.3%
    expect(r.ok).toBe(true)
    expect(r.sourceDisagreement).toBe(true)
  })

  it('without apyBase7d (most pools) the 7-day growth is checked against the base APY instead', async () => {
    // 2026-10-10: apyBase7d was numeric for 167 of 1,315 Ethereum stable pools and for none of
    // the 12 ranked rows, so the cross-check never ran where it mattered (HUMAUSDC: headline
    // 7.83% vs realized 6.56%).
    const noSeven = { ...input, apyBase7dPct: null, apyBasePct: 7.83 }
    const r = await verifyOnChain(fakeClient({ now: 1_001_200n }), anchor, noSeven) // ~6.5% trailing
    expect(r.checks).toContain('trailing-7d vs base APY')
    expect(r.sourceDisagreement).toBe(true)
    const close = await verifyOnChain(fakeClient({ now: 1_001_200n }), anchor, {
      ...noSeven,
      apyBasePct: 6.4,
    })
    expect(close.sourceDisagreement).toBe(false)
  })
})

describe('source schema checks', () => {
  it('rejects a /pools body that is not {status:"success", data:[]} or has too many malformed rows', () => {
    expect(() => parsePools({ data: [] })).toThrow(SourceError)
    const good = {
      pool: 'x',
      chain: 'Ethereum',
      project: 'p',
      symbol: 'S',
      tvlUsd: 1,
      stablecoin: true,
    }
    const rows = Array.from({ length: 1000 }, () => good)
    expect(parsePools({ status: 'success', data: rows })).toHaveLength(1000)
    expect(() =>
      parsePools({
        status: 'success',
        data: [...rows, ...Array.from({ length: 20 }, () => ({ pool: 'x' }))],
      }),
    ).toThrow(/malformed/)
  })
})
