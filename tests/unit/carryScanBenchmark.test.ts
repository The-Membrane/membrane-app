import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import {
  buildBenchmarks,
  eligibleLlamaBench,
  onchainBench,
  type OnchainBenchVenue,
} from '@/lib/carryScan/benchmark'
import type { LlamaLendBorrow, LlamaPool, MorphoMarketInfo } from '@/lib/carryScan/types'
import { bigintReviver } from '@/lib/netApy/fixedPoint'
import type { VenueSnapshot } from '@/lib/netApy/types'
import { NET_APY_VENUES } from '@/lib/netApy/venues'

const fx = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'carry-scan-sources.json'), 'utf8'),
) as {
  pools: LlamaPool[]
  lendBorrow: LlamaLendBorrow[]
  morphoMarkets: MorphoMarketInfo[]
}
const irm = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'net-apy-irm.json'), 'utf8'),
  bigintReviver,
) as {
  anchor: VenueSnapshot['anchor']
  snapshots: VenueSnapshot[]
}
const llama = eligibleLlamaBench(fx.pools, fx.lendBorrow, fx.morphoMarkets)
const reason = (pool: string) => llama.rejected.find((r) => r.pool === pool)?.reason

describe('S3 benchmark eligibility', () => {
  it('admits Aave Core, Spark and listed blue-chip Morpho markets with ≥ $5M borrowed', () => {
    const want: [string, string, number][] = [
      ['pool-morpho-wsteth-usdt', 'USDT', 0.031],
      ['pool-morpho-wbtc-rlusd', 'RLUSD', 0.0227],
      ['pool-aave-usdc', 'USDC', Math.expm1(0.0494)],
      ['pool-spark-usdc', 'USDC', Math.expm1(0.0437)],
    ]
    expect(llama.eligible.map((r) => [r.pool, r.stable])).toEqual(want.map(([p, s]) => [p, s]))
    llama.eligible.forEach((r, i) => expect(r.apy).toBeCloseTo(want[i][2], 12))
  })

  it('converts Aave v3 and SparkLend borrow rates from APR to APY; Morpho rows are already APYs', () => {
    // Read 2026-10-10: DeFiLlama `apyBaseBorrow` equals the on-chain currentVariableBorrowRate
    // APR to 5 dp for Aave v3 (DAI 4.94415, GHO 4.5) and SparkLend (PYUSD 4.28875, USDC 4.36881);
    // Morpho's 3.1028 matches the Morpho API borrowApy. A min over mixed APR/APY rows is wrong.
    const apy = (pool: string) => llama.eligible.find((r) => r.pool === pool)!.apy
    expect(apy('pool-spark-usdc')).toBeCloseTo(Math.expm1(0.0437), 12) // 4.4669%, not 4.37%
    expect(apy('pool-aave-usdc')).toBeCloseTo(Math.expm1(0.0494), 12)
    expect(apy('pool-morpho-wsteth-usdt')).toBeCloseTo(0.031, 12)
  })

  it('reads the Morpho LOAN from mintedCoin, never the collateral the row describes', () => {
    const r = llama.eligible.find((x) => x.pool === 'pool-morpho-wsteth-usdt')!
    expect(r.stable).toBe('USDT') // the pool row's symbol is WSTETH and its TVL is the collateral's
    expect(r.venue).toBe('Morpho WSTETH/USDT 86%')
  })

  it('rejects phantom rows: $0 borrowed, exotic collateral, and the permissioned Horizon market', () => {
    expect(reason('pool-morpho-wsteth-usdc-empty')).toMatch(/under \$5M borrowed/)
    expect(reason('pool-morpho-susde-usdc-idle')).toMatch(/not blue-chip/) // the 0.06% "cheapest" USDC
    expect(reason('pool-morpho-collateral-usdc')).toMatch(/not blue-chip/)
    expect(reason('pool-aave-horizon-rlusd')).toBe('permissioned market (Aave Horizon)')
    expect(reason('pool-aave-core-rlusd')).toMatch(/under \$5M borrowed/)
  })

  it('takes the minimum per stable and never borrows another stable’s rate', () => {
    const b = buildBenchmarks(llama, [], NET_APY_VENUES, ['USDC', 'USDT'])
    expect(b.table.USDC.bySize['100k']).toMatchObject({
      venue: 'SparkLend USDC',
      labelClass: 'reported',
      source: 'defillama',
    })
    expect(b.table.USDC.bySize['100k']?.apy).toBeCloseTo(Math.expm1(0.0437), 12)
    expect(b.table.RLUSD.bySize['100k']?.apy).toBe(0.0227)
    expect(b.table.crvUSD).toBeUndefined()
  })
})

describe('S3 on-chain benchmark', () => {
  const onVenues = onchainBench(irm.snapshots, [], Number(irm.anchor.blockTimestamp))

  it('a null at size is skipped, never read as 0', () => {
    // spark-usdc holds ~$4.1M of cash in the fixture: a $10M borrow cannot be priced.
    const spark = onVenues.find((v) => v.venueKey === 'spark-usdc')!
    expect(spark.apyBySize['100k']).toBeGreaterThan(0)
    expect(spark.apyBySize['10m']).toBeNull()
    const only: OnchainBenchVenue[] = [{ ...spark }]
    const b = buildBenchmarks({ eligible: [], rejected: [] }, only, NET_APY_VENUES, [])
    expect(b.table.USDC.bySize['100k']?.apy).toBeGreaterThan(0)
    expect(b.table.USDC.bySize['10m']).toBeNull()
  })

  it('replaces the DeFiLlama row of a market the registry read on-chain, and records the agreement', () => {
    const b = buildBenchmarks(llama, onVenues, NET_APY_VENUES, ['USDC', 'USDT'])
    const usdc = b.table.USDC.candidates
    expect(usdc.some((c) => c.source === 'defillama' && c.venue.includes('SparkLend'))).toBe(false)
    expect(usdc.some((c) => c.source === 'defillama' && c.venue.includes('Aave v3'))).toBe(false)
    expect(b.agreement.USDC.onchain).not.toBeNull()
    expect(b.agreement.USDC.defillama).toBeCloseTo(Math.expm1(0.0437), 12)
    // Every chosen benchmark at every size is a real rate, never a 0 standing in for "no data".
    for (const t of Object.values(b.table))
      for (const r of Object.values(t.bySize)) if (r) expect(r.apy).toBeGreaterThan(0)
  })
})

describe('S3 on-chain candidates pass the same eligibility rules as DeFiLlama rows', () => {
  const onVenues = onchainBench(irm.snapshots, [], Number(irm.anchor.blockTimestamp))
  const labels = (b: ReturnType<typeof buildBenchmarks>, s: string) =>
    (b.table[s]?.candidates ?? []).map((c) => c.venue)

  it('drops Euler (not an eligible venue type) and markets under $5M borrowed, whatever their rate', () => {
    // Fixture: Euler eUSDC-2 has ~$2.0M borrowed, Aave v3 USDS ~$0.34M.
    const b = buildBenchmarks(llama, onVenues, NET_APY_VENUES, ['USDC', 'USDT'])
    expect(labels(b, 'USDC')).not.toContain('Euler eUSDC-2')
    expect(labels(b, 'USDT')).not.toContain('Euler eUSDT-2')
    expect(labels(b, 'USDS')).not.toContain('Aave v3 USDS')
    expect(labels(b, 'USDC')).toContain('SparkLend USDC')
    const why = (v: string) => b.rejected.find((r) => r.venue === v)?.reason
    expect(why('Euler eUSDC-2')).toMatch(/not an eligible benchmark venue/)
    expect(why('Aave v3 USDS')).toMatch(/under \$5M borrowed/)
  })

  it('a cheaper ineligible on-chain rate never becomes the benchmark', () => {
    const euler = onVenues.find((v) => v.venueKey === 'euler-v2-eusdc-2')!
    const spark = onVenues.find((v) => v.venueKey === 'spark-usdc')!
    const cheap = { ...euler, apyBySize: { '100k': 0.001, '1m': 0.001, '10m': 0.001 } }
    const b = buildBenchmarks({ eligible: [], rejected: [] }, [cheap, spark], NET_APY_VENUES, [])
    expect(b.table.USDC.bySize['100k']?.venue).toBe('SparkLend USDC')
  })

  it('an on-chain Morpho market must be listed and blue-chip, like its DeFiLlama row', () => {
    const b = buildBenchmarks(llama, onVenues, NET_APY_VENUES, ['USDC', 'USDT'], {
      morphoListed: fx.morphoMarkets,
    })
    // The fixture lists wstETH/USDT 86% (0xe7e9…) and none of the registry's USDC markets.
    expect(labels(b, 'USDT')).toContain('Morpho wstETH/USDT 86%')
    expect(labels(b, 'USDC')).not.toContain('Morpho cbBTC/USDC 86%')
    expect(b.rejected.find((r) => r.venue === 'Morpho cbBTC/USDC 86%')?.reason).toBe(
      'Morpho market not listed',
    )
  })
})
