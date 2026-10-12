// LIVE: our IRM math vs the venues' own on-chain getters, at a pinned block.
//
// Skipped unless NET_APY_LIVE=1 (it needs an archive RPC; unit CI stays offline).
//   NET_APY_LIVE=1 pnpm vitest run tests/unit/netApy.live.test.ts
//   NET_APY_LIVE=1 NET_APY_RECORD=1 …   also rewrites tests/unit/fixtures/net-apy-irm.json
//
// For every venue and every case in netApyCases.ts it calls the venue's own rate
// function with the exact post-size inputs and demands EXACT equality with ours:
//   Aave v3     strategy.calculateInterestRates(params)        (liquidity + variable)
//   SparkLend   strategy.calculateInterestRates(v3.0 params)   (liquidity + variable)
//   Morpho      AdaptiveCurveIrm.borrowRateView(params, market)
//   Euler v2    IRMLinearKink.computeInterestRateView(vault, cash, borrows)
// The getters ARE the on-chain math, so equality at many sizes is the proof that the
// projection at size is what the venue would compute.

import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { bigintReplacer } from '@/lib/netApy/fixedPoint'
import { readAllVenues, type SnapshotSet } from '@/lib/netApy/read'
import { netApyClient } from '@/lib/netApy/rpc'
import type { VenueSnapshot } from '@/lib/netApy/types'
import { NET_APY_VENUES, usdToRaw } from '@/lib/netApy/venues'

import { cashOf, localRates, PINNED_BLOCK, SIZES_USD, type IrmCase, type Side } from './netApyCases'

const LIVE = process.env.NET_APY_LIVE === '1'
const RECORD = process.env.NET_APY_RECORD === '1'

const aaveCalcAbi = [
  {
    type: 'function',
    name: 'calculateInterestRates',
    stateMutability: 'view',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'unbacked', type: 'uint256' },
          { name: 'liquidityAdded', type: 'uint256' },
          { name: 'liquidityTaken', type: 'uint256' },
          { name: 'totalDebt', type: 'uint256' },
          { name: 'reserveFactor', type: 'uint256' },
          { name: 'reserve', type: 'address' },
          { name: 'usingVirtualBalance', type: 'bool' },
          { name: 'virtualUnderlyingBalance', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ type: 'uint256' }, { type: 'uint256' }],
  },
] as const

const sparkCalcAbi = [
  {
    type: 'function',
    name: 'calculateInterestRates',
    stateMutability: 'view',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'unbacked', type: 'uint256' },
          { name: 'liquidityAdded', type: 'uint256' },
          { name: 'liquidityTaken', type: 'uint256' },
          { name: 'totalStableDebt', type: 'uint256' },
          { name: 'totalVariableDebt', type: 'uint256' },
          { name: 'averageStableBorrowRate', type: 'uint256' },
          { name: 'reserveFactor', type: 'uint256' },
          { name: 'reserve', type: 'address' },
          { name: 'aToken', type: 'address' },
        ],
      },
    ],
    outputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
  },
] as const

const marketParamsTuple = {
  type: 'tuple',
  components: [
    { name: 'loanToken', type: 'address' },
    { name: 'collateralToken', type: 'address' },
    { name: 'oracle', type: 'address' },
    { name: 'irm', type: 'address' },
    { name: 'lltv', type: 'uint256' },
  ],
} as const
const marketTuple = {
  type: 'tuple',
  components: [
    { name: 'totalSupplyAssets', type: 'uint128' },
    { name: 'totalSupplyShares', type: 'uint128' },
    { name: 'totalBorrowAssets', type: 'uint128' },
    { name: 'totalBorrowShares', type: 'uint128' },
    { name: 'lastUpdate', type: 'uint128' },
    { name: 'fee', type: 'uint128' },
  ],
} as const
const morphoIrmAbi = [
  { type: 'function', name: 'borrowRateView', stateMutability: 'view', inputs: [marketParamsTuple, marketTuple], outputs: [{ type: 'uint256' }] },
] as const

const eulerIrmAbi = [
  {
    type: 'function',
    name: 'computeInterestRateView',
    stateMutability: 'view',
    inputs: [
      { name: 'vault', type: 'address' },
      { name: 'cash', type: 'uint256' },
      { name: 'borrows', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const

async function onchainRates(s: VenueSnapshot, side: Side, size: bigint): Promise<IrmCase['onchain']> {
  const { client } = netApyClient()
  const blockNumber = s.anchor.blockNumber
  const supply = side === 'supply' ? size : 0n
  const borrow = side === 'borrow' ? size : 0n
  const { irm, state } = s
  if (irm.model === 'aave-rate-strategy-v2' && state.kind === 'aave-virtual') {
    const [liquidityRate, borrowRate] = await client.readContract({
      address: irm.strategy,
      abi: aaveCalcAbi,
      functionName: 'calculateInterestRates',
      args: [
        {
          unbacked: state.unbacked,
          liquidityAdded: supply,
          liquidityTaken: borrow,
          totalDebt: state.totalDebt + borrow,
          reserveFactor: state.reserveFactorBps,
          reserve: s.asset.address,
          usingVirtualBalance: true,
          virtualUnderlyingBalance: state.virtualUnderlyingBalance,
        },
      ],
      blockNumber,
    })
    return { borrowRate, liquidityRate }
  }
  if (irm.model === 'spark-variable-borrow' && state.kind === 'spark') {
    const [liquidityRate, , borrowRate] = await client.readContract({
      address: irm.strategy,
      abi: sparkCalcAbi,
      functionName: 'calculateInterestRates',
      args: [
        {
          unbacked: state.unbacked,
          liquidityAdded: supply,
          liquidityTaken: borrow,
          totalStableDebt: 0n,
          totalVariableDebt: state.totalVariableDebt + borrow,
          averageStableBorrowRate: 0n,
          reserveFactor: state.reserveFactorBps,
          reserve: s.asset.address,
          aToken: state.aToken,
        },
      ],
      blockNumber,
    })
    return { borrowRate, liquidityRate }
  }
  if (irm.model === 'morpho-adaptive-curve' && state.kind === 'morpho-market') {
    const borrowRate = await client.readContract({
      address: irm.irm,
      abi: morphoIrmAbi,
      functionName: 'borrowRateView',
      args: [
        { loanToken: state.loanToken, collateralToken: state.collateralToken, oracle: state.oracle, irm: irm.irm, lltv: state.lltv },
        {
          totalSupplyAssets: state.totalSupplyAssets + supply,
          totalSupplyShares: state.totalSupplyShares,
          totalBorrowAssets: state.totalBorrowAssets + borrow,
          totalBorrowShares: state.totalBorrowShares,
          lastUpdate: state.lastUpdate,
          fee: state.fee,
        },
      ],
      blockNumber,
    })
    return { borrowRate }
  }
  if (irm.model === 'euler-linear-kink' && state.kind === 'euler-vault') {
    const def = NET_APY_VENUES.find((v) => v.venueKey === s.venueKey)
    if (!def || def.protocol !== 'euler-v2') throw new Error('euler venue missing from registry')
    const borrowRate = await client.readContract({
      address: irm.irm,
      abi: eulerIrmAbi,
      functionName: 'computeInterestRateView',
      args: [def.vault, state.cash + supply - borrow, state.totalBorrows + borrow],
      blockNumber,
    })
    return { borrowRate }
  }
  throw new Error(`no on-chain getter for ${s.venueKey}`)
}

describe.skipIf(!LIVE)('net APY at size — IRM math vs on-chain getters at a pinned block', () => {
  let set: SnapshotSet
  const cases: IrmCase[] = []

  it(
    'reads every registered venue at the pinned block (registry re-verified)',
    async () => {
      const { client, label } = netApyClient()
      set = await readAllVenues(client, NET_APY_VENUES, label, PINNED_BLOCK)
      expect(set.errors).toEqual([])
      expect(set.anchor.blockNumber).toBe(PINNED_BLOCK)
      expect(set.snapshots.map((s) => s.venueKey).sort()).toEqual(NET_APY_VENUES.map((v) => v.venueKey).sort())
    },
    120_000,
  )

  it(
    'reproduces every on-chain rate exactly, at every size, on both sides',
    async () => {
      for (const s of set.snapshots) {
        for (const side of ['supply', 'borrow'] as const) {
          for (const usd of SIZES_USD) {
            const size = usdToRaw(usd, s.asset)
            if (side === 'borrow' && size > cashOf(s)) continue
            const onchain = await onchainRates(s, side, size)
            expect({ venue: s.venueKey, side, usd, ...localRates(s, side, size) }).toEqual({ venue: s.venueKey, side, usd, ...onchain })
            cases.push({ venueKey: s.venueKey, side, sizeRaw: size, onchain })
          }
        }
      }
      expect(cases.length).toBeGreaterThan(NET_APY_VENUES.length * 6)
    },
    600_000,
  )

  it.skipIf(!RECORD)('records the fixture for the offline test', () => {
    const dir = join(process.cwd(), 'tests', 'unit', 'fixtures')
    mkdirSync(dir, { recursive: true })
    const body = {
      _comment:
        'Recorded by tests/unit/netApy.live.test.ts (NET_APY_LIVE=1 NET_APY_RECORD=1). Snapshots = inputs read at the pinned block; cases = what each venue’s own IRM getter returned for those inputs plus the size. RPC label only — never a URL.',
      anchor: set.anchor,
      rpc: set.rpc,
      snapshots: set.snapshots,
      cases,
    }
    writeFileSync(join(dir, 'net-apy-irm.json'), JSON.stringify(body, bigintReplacer, 1) + '\n')
  })
})
