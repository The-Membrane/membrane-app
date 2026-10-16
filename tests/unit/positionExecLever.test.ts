// components/PositionV0/leverExec.ts — the re-read and re-solve behind the order slip, and
// the slip's rows and steps; config/evm/chains.ts — Ethereum is an execution-only chain.

import { describe, expect, it } from 'vitest'
import type { PublicClient } from 'viem'

import {
  DEFAULT_EVM_CHAIN,
  anvil,
  executionOnlyChains,
  isAppChain,
  supportedEvmChains,
} from '@/config/evm/chains'
import {
  findFreshRow,
  goneReason,
  legFor,
  positionKeyOf,
  prepareLever,
  slipRows,
  stepsOf,
  type LeverIntent,
} from '@/components/PositionV0/leverExec'
import { buildPositionView } from '@/components/PositionV0/viewModel'
import { leverCalls } from '@/lib/position-exec/builders'
import { fmtUsd } from '@/lib/position/format'
import { roundTowardRisk, priceDecimals } from '@/lib/position/liquidation'
import { formatChance } from '@/lib/position/touch'
import { TOUCH_TABLE } from '@/lib/position/touchHistory'
import type {
  AdapterResult,
  CollateralLeg,
  DebtLeg,
  ProtocolPosition,
} from '@/lib/position-sim/types'

const OWNER = '0x7ada000000000000000000000000000000d14200' as const
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'

const coll = (
  symbol: string,
  address: string,
  decimals: number,
  amount: number,
  priceUsd: number,
  lt: number,
): CollateralLeg => ({
  symbol,
  address,
  decimals,
  amount,
  priceUsd,
  valueUsd: amount * priceUsd,
  liquidationThreshold: lt,
  maxLtv: lt - 0.03,
  liquidationBonus: 0.05,
})
const debt = (
  symbol: string,
  address: string,
  decimals: number,
  amount: number,
  priceUsd: number,
): DebtLeg => ({
  symbol,
  address,
  decimals,
  amount,
  priceUsd,
  valueUsd: amount * priceUsd,
  borrowApr: 0.05,
})
function pos(c: CollateralLeg[], d: DebtLeg[]): ProtocolPosition {
  const C = c.reduce((s, x) => s + x.valueUsd, 0)
  const D = d.reduce((s, x) => s + x.valueUsd, 0)
  const W = c.reduce((s, x) => s + x.valueUsd * x.liquidationThreshold, 0)
  return {
    protocol: 'aave-v3',
    label: 'Aave V3',
    collateral: c,
    debt: d,
    totalCollateralUsd: C,
    totalDebtUsd: D,
    ltv: D / C,
    liquidationLtv: W / C,
    healthFactor: W / D,
    provenance: {
      kind: 'onchain',
      label: 'aave v3 · public rpc',
      at: 1_760_000_000_000,
      block: 26_207_311,
    },
  }
}

const P = pos([coll('WETH', WETH, 18, 10, 4000, 0.83)], [debt('USDC', USDC, 6, 25_000, 1)])
const VIEW = buildPositionView(P, TOUCH_TABLE)
const ROWS = VIEW.forecast!.byHorizon['7d'].actions
const REPAY = ROWS.find((r) => r.kind === 'repay')!
const ADD = ROWS.find((r) => r.kind === 'add')!

const intentOf = (row = REPAY, o: Partial<LeverIntent> = {}): LeverIntent => ({
  owner: OWNER,
  positionKey: positionKeyOf(P),
  protocol: 'aave-v3',
  title: VIEW.title,
  kind: row.kind,
  targetPct: row.targetPct,
  level: row.level,
  horizon: '7d',
  stale: false,
  row,
  openedAt: 1,
  ...o,
})

describe('the fixture has levers to click', () => {
  it('solves a repay in USDC and a top-up in WETH', () => {
    expect(REPAY).toMatchObject({ kind: 'repay', symbol: 'USDC' })
    expect(ADD).toMatchObject({ kind: 'add', symbol: 'WETH' })
  })
})

describe('finding the clicked lever in a fresh solve', () => {
  it('matches kind and target, then kind and level', () => {
    expect(findFreshRow(ROWS, REPAY)).toBe(REPAY)
    expect(findFreshRow(ROWS, { kind: 'repay', targetPct: 999, level: REPAY.level })).toBe(REPAY)
    expect(findFreshRow(ROWS, { kind: 'repay', targetPct: 999, level: 999 })).toBeNull()
  })
  it('maps a row back to its leg, with address and decimals; refuses an ambiguous symbol', () => {
    expect(legFor(P, REPAY)).toEqual({ symbol: 'USDC', address: USDC, decimals: 6 })
    expect(legFor(P, ADD)).toEqual({ symbol: 'WETH', address: WETH, decimals: 18 })
    const twin = pos(
      [coll('WETH', WETH, 18, 10, 4000, 0.83)],
      [debt('USDC', USDC, 6, 1, 1), debt('USDC', WETH, 6, 1, 1)],
    )
    expect(() => legFor(twin, REPAY)).toThrow(/more than one debt leg named USDC/)
    expect(() => legFor(P, { kind: 'repay', symbol: 'DAI' })).toThrow(/no debt leg named DAI/)
  })
  it('says why a lever is gone', () => {
    const noDebt = buildPositionView(pos([coll('WETH', WETH, 18, 10, 4000, 0.83)], []), TOUCH_TABLE)
    expect(goneReason(noDebt, { kind: 'repay', horizon: '7d' })).toBe(
      'This position has no debt now.',
    )
    const far = buildPositionView(
      pos([coll('WETH', WETH, 18, 10, 4000, 0.83)], [debt('USDC', USDC, 6, 100, 1)]),
      TOUCH_TABLE,
    )
    expect(goneReason(far, { kind: 'repay', horizon: '7d' })).toMatch(
      /Already at this lever's target within 7 days/,
    )
  })
})

describe("the slip rows: the page's own figures, brought forward → carried forward", () => {
  it("prices the new line at the row's floored distance, rounded toward risk like the hero", () => {
    const rows = slipRows(VIEW, REPAY, '7d', false)
    const hero = VIEW.hero as Extract<typeof VIEW.hero, { kind: 'line' }>
    const raw = hero.priceNow * (1 - REPAY.newDistancePct / 100)
    expect(rows[0]).toEqual({
      label: 'WETH liquidation price',
      before: fmtUsd(hero.priceShown, hero.decimals),
      after: fmtUsd(roundTowardRisk(raw, 'fall', priceDecimals(raw)), priceDecimals(raw)),
    })
    expect(rows[1]).toEqual({
      label: 'Distance from now',
      before: `−${hero.distancePct}%`,
      after: `−${REPAY.newDistancePct}%`,
    })
    expect(rows[2].label).toBe('Chance ETH touches it, 7 days†')
    expect(rows[2].after.startsWith(formatChance(REPAY.history.touched, REPAY.history.n))).toBe(
      true,
    )
  })
  it('withholds the chance while the forecast is STALE', () => {
    expect(slipRows(VIEW, REPAY, '7d', true).map((r) => r.label)).toEqual([
      'WETH liquidation price',
      'Distance from now',
    ])
  })
})

describe('the steps, read back from the calls', () => {
  it('names the exact units, the contract approved, and the owner', () => {
    const calls = leverCalls(
      { venue: 'aave', kind: 'repay', pool: POOL, asset: USDC, amount: 460_000_000n, owner: OWNER },
      1n,
    )
    const steps = stepsOf(calls, {
      protocol: 'aave-v3',
      kind: 'repay',
      symbol: 'USDC',
      shown: '460',
    })
    expect(steps.map((s) => s.title)).toEqual([
      'Reset the USDC allowance to 0',
      'Approve exactly 460 USDC',
      'Repay 460 USDC, variable rate',
    ])
    expect(steps[1].detail).toBe('USDC 0xa0b8…eb48 · approve Aave V3 Pool 0x8787…a4e2 · 460000000')
    expect(steps[2].detail).toBe('Aave V3 Pool 0x8787…a4e2 · repay · 460000000 · for 0x7ada…4200')
    const comet = stepsOf(
      leverCalls({ venue: 'compound', kind: 'repay', comet: POOL, asset: USDC, amount: 1n }, 1n),
      {
        protocol: 'compound-v3',
        kind: 'repay',
        symbol: 'USDC',
        shown: '0.000001',
      },
    )
    expect(comet.at(-1)!.title).toBe('Repay 0.000001 USDC')
  })
})

// ------------------------------------------------------------------ prepare, end to end on fakes

function fakeClient(): PublicClient {
  const A = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c'
  const V = '0x72e95b8931767c79ba4eee721354d6e99a61d004'
  return {
    multicall: async ({ contracts }: { contracts: { address: string; functionName: string }[] }) =>
      contracts.map((c) => {
        const result = (() => {
          switch (c.functionName) {
            case 'getPool':
              return POOL
            case 'getReserveData':
              return {
                configuration: (6n << 48n) | (1n << 56n),
                aTokenAddress: A,
                stableDebtTokenAddress: `0x${'0'.repeat(40)}`,
                variableDebtTokenAddress: V,
                accruedToTreasury: 0n,
              }
            case 'balanceOf':
              return c.address === V ? 25_000_000_000n : 1_000_000_000_000n
            case 'scaledTotalSupply':
              return 0n
            case 'getReserveNormalizedIncome':
              return 10n ** 27n
            case 'decimals':
              return 6
            case 'allowance':
              return 0n
            default:
              throw new Error(c.functionName)
          }
        })()
        return { status: 'success', result }
      }),
  } as unknown as PublicClient
}

const ok = (positions: ProtocolPosition[]): AdapterResult => ({
  protocol: 'aave-v3',
  label: 'Aave V3',
  status: 'ok',
  positions,
  fetchedAt: 1,
})

describe('prepareLever', () => {
  it('re-reads, re-solves, converts the amount exactly and builds [approve, repay] for the owner', async () => {
    const seen: string[] = []
    const p = await prepareLever(intentOf(), {
      readAdapter: async (protocol, owner) => {
        seen.push(`${protocol}:${owner}`)
        return ok([P])
      },
      client: fakeClient(),
      table: TOUCH_TABLE,
    })
    expect(seen).toEqual([`aave-v3:${OWNER}`])
    if (p.kind !== 'ready') throw new Error(p.reason)
    expect(p.amount).toBe(BigInt(REPAY.amount.toFixed(REPAY.amountDecimals)) * 10n ** 6n)
    expect(p.changed).toBe(false)
    expect(p.block).toBe(26_207_311)
    expect(p.gates.every((g) => g.ok)).toBe(true)
    expect(p.calls.map((c) => [c.address, c.functionName])).toEqual([
      [USDC, 'approve'],
      [POOL, 'repay'],
    ])
    expect(p.calls[1].args).toEqual([USDC, p.amount, 2n, OWNER])
  })
  it('reflects now: a position that moved re-solves to a new amount, flagged as changed', async () => {
    const moved = pos([coll('WETH', WETH, 18, 10, 3900, 0.83)], [debt('USDC', USDC, 6, 25_000, 1)])
    const p = await prepareLever(intentOf(), {
      readAdapter: async () => ok([moved]),
      client: fakeClient(),
      table: TOUCH_TABLE,
    })
    if (p.kind !== 'ready') throw new Error(p.reason)
    expect(p.row.amount).not.toBe(REPAY.amount)
    expect(p.changed).toBe(true)
  })
  it('is gone when the position is no longer there; throws, named, when the re-read fails', async () => {
    await expect(
      prepareLever(intentOf(), {
        readAdapter: async () => ok([]),
        client: fakeClient(),
        table: TOUCH_TABLE,
      }),
    ).resolves.toEqual({
      kind: 'gone',
      reason: 'This position is no longer open on Aave V3.',
    })
    const failed: AdapterResult = {
      protocol: 'aave-v3',
      label: 'Aave V3',
      status: 'error',
      positions: [],
      message: 'HTTP 429',
      fetchedAt: 1,
    }
    await expect(
      prepareLever(intentOf(), {
        readAdapter: async () => failed,
        client: fakeClient(),
        table: TOUCH_TABLE,
      }),
    ).rejects.toThrow('Aave V3 re-read failed: HTTP 429')
  })
})

describe('Ethereum is an execution-only chain', () => {
  it('joins no app list: the default chain and the app chains are unchanged', () => {
    expect(supportedEvmChains.map((c) => c.id)).toEqual([anvil.id])
    expect(DEFAULT_EVM_CHAIN.id).toBe(anvil.id)
    expect(executionOnlyChains.map((c) => c.id)).toEqual([1])
    expect(isAppChain(anvil.id)).toBe(true)
    expect(isAppChain(1)).toBe(false)
    expect(isAppChain(undefined)).toBe(false)
  })
})
