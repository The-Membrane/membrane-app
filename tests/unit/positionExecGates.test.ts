// lib/position-exec/read.ts and gates.ts — the execution-time read against a fake
// multicall, and every gate: reserve state, debt type, supply cap, balance, decimals.

import { describe, expect, it } from 'vitest'
import type { PublicClient } from 'viem'

import { morphoMarketId, type MorphoMarketParams } from '@/lib/position-exec/builders'
import {
  amountLimit,
  capLine,
  firstBlocked,
  leverGates,
  pausedText,
  type GateInput,
} from '@/lib/position-exec/gates'
import {
  aaveCapRoom,
  decodeAaveConfig,
  morphoSharesDown,
  rayMul,
  readLeverChain,
  type LeverChainRead,
  type VenueRead,
} from '@/lib/position-exec/read'
import {
  AAVE_V3_MAINNET_ADDRESSES_PROVIDER,
  SPARK_MAINNET_ADDRESSES_PROVIDER,
} from '@/lib/position-sim/adapters'

const OWNER = '0x7ada000000000000000000000000000000d14200' as const
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' as const
const POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2' as const
const SPARK_POOL = '0xc13e21b648a5ee794902342038ff3adab66be987' as const
const COMET = '0xc3d688b66703497daa19211eedff47f25384cdc3' as const
const RAY = 10n ** 27n

/** A reserve configuration word with the given flags (ReserveConfiguration.sol layout). */
function config(o: {
  decimals: number
  active?: boolean
  frozen?: boolean
  paused?: boolean
  supplyCap?: bigint
}): bigint {
  let w = BigInt(o.decimals) << 48n
  if (o.active ?? true) w |= 1n << 56n
  if (o.frozen) w |= 1n << 57n
  if (o.paused) w |= 1n << 60n
  w |= (o.supplyCap ?? 0n) << 116n
  // Noise in the bits around them must not leak in: LTV, threshold, borrowing, reserve factor.
  w |= 8000n | (8300n << 16n) | (1n << 58n) | (1000n << 64n)
  return w
}

describe('Aave reserve configuration', () => {
  it('decodes decimals, active, frozen, paused and the supply cap from their bits', () => {
    expect(decodeAaveConfig(config({ decimals: 6, supplyCap: 2_000_000_000n }))).toEqual({
      decimals: 6,
      active: true,
      frozen: false,
      paused: false,
      supplyCap: 2_000_000_000n,
    })
    const f = decodeAaveConfig(config({ decimals: 18, frozen: true, paused: true, active: false }))
    expect(f).toMatchObject({
      decimals: 18,
      active: false,
      frozen: true,
      paused: true,
      supplyCap: 0n,
    })
  })
  it('measures room under the cap as cap × 10^decimals − (scaled + treasury) × income', () => {
    const flags = decodeAaveConfig(config({ decimals: 6, supplyCap: 1_000n }))
    // 900 tokens scaled at an income index of 1.1 → 990 supplied, 10 tokens of room.
    expect(aaveCapRoom(flags, 800_000_000n, 100_000_000n, (11n * RAY) / 10n)).toBe(10_000_000n)
    expect(aaveCapRoom(flags, 1_000_000_000n, 0n, RAY)).toBe(0n)
    expect(aaveCapRoom(decodeAaveConfig(config({ decimals: 6 })), 1n, 0n, RAY)).toBeNull()
    expect(rayMul(3n, RAY / 2n)).toBe(2n) // half up, as WadRayMath
  })
})

describe('Morpho share math', () => {
  it('burns assets × (shares + 1e6) / (assets + 1), rounded down', () => {
    expect(morphoSharesDown(1_000_000n, 10_000_000n, 10_000_000n * 10n ** 6n)).toBe(
      (1_000_000n * (10n ** 13n + 10n ** 6n)) / 10_000_001n,
    )
  })
})

// ------------------------------------------------------------------ gates

const read = (venue: VenueRead, o: Partial<LeverChainRead> = {}): LeverChainRead => ({
  block: 1n,
  decimals: 6,
  balance: 10_000_000_000n,
  allowance: 0n,
  venue,
  action: {
    venue: 'aave',
    kind: 'repay',
    pool: POOL,
    asset: USDC,
    amount: 460_000_000n,
    owner: OWNER,
  },
  ...o,
})
const aave = (
  o: Partial<Extract<VenueRead, { venue: 'aave' }>> = {},
  flags: Parameters<typeof config>[0] = { decimals: 6 },
): VenueRead => ({
  venue: 'aave',
  pool: POOL,
  flags: decodeAaveConfig(config(flags)),
  variableDebt: 5_000_000_000n,
  stableDebt: 0n,
  capRoom: null,
  ...o,
})
const input = (r: LeverChainRead, o: Partial<GateInput> = {}): GateInput => ({
  kind: 'repay',
  symbol: 'USDC',
  token: USDC,
  legDecimals: 6,
  amount: 460_000_000n,
  shown: 2,
  read: r,
  ...o,
})

describe('gates: Aave V3 / Spark', () => {
  it('passes a repay on an active reserve with the debt and the balance', () => {
    const g = leverGates(input(read(aave())))
    expect(g.map((x) => x.id)).toEqual(['decimals', 'venue', 'debt', 'balance'])
    expect(firstBlocked(g)).toBeNull()
    expect(g.find((x) => x.id === 'balance')!.text).toBe('Balance covers 460.00 USDC')
  })
  it('blocks a paused or inactive reserve; frozen blocks a supply but not a repay', () => {
    expect(
      firstBlocked(leverGates(input(read(aave({}, { decimals: 6, paused: true })))))!.text,
    ).toBe(
      'Aave has paused this market (a governance/guardian switch). Until it is unpaused nobody can supply, withdraw, borrow or repay this asset, so this transaction would fail. Your position is unchanged.',
    )
    // The venue's own name, when the slip gives it.
    expect(
      firstBlocked(
        leverGates({ ...input(read(aave({}, { decimals: 6, paused: true }))), venueName: 'Spark' }),
      )!.text,
    ).toBe(pausedText('Spark'))
    expect(pausedText('Spark')).toMatch(/^Spark has paused this market/)
    expect(
      firstBlocked(leverGates(input(read(aave({}, { decimals: 6, active: false })))))!.text,
    ).toBe('Reserve is not active')
    expect(
      firstBlocked(leverGates(input(read(aave({}, { decimals: 6, frozen: true }))))),
    ).toBeNull()
    const add = input(read(aave({}, { decimals: 6, frozen: true })), { kind: 'add' })
    expect(firstBlocked(leverGates(add))!.text).toBe('Reserve is frozen: no new supply')
  })
  it('names legacy stable-rate debt (Spark) instead of repaying it as variable', () => {
    const g = leverGates(
      input(read(aave({ variableDebt: 100_000_000n, stableDebt: 900_000_000n }))),
    )
    expect(firstBlocked(g)).toMatchObject({
      id: 'debt',
      text: 'Repay exceeds the variable-rate debt (100.00 USDC); 900.00 USDC is stable-rate, not repaid here',
    })
    // Within the variable debt, mode 2 repays it exactly: allowed even with stable debt beside it.
    expect(
      firstBlocked(leverGates(input(read(aave({ variableDebt: 460_000_000n, stableDebt: 1n }))))),
    ).toBeNull()
  })
  it('blocks a supply over the cap and passes one under it', () => {
    const over = input(read(aave({ capRoom: 100_000_000n })), { kind: 'add' })
    expect(firstBlocked(leverGates(over))!.text).toBe('Over the supply cap: room 100.00 USDC')
    const under = input(read(aave({ capRoom: 460_000_000n })), { kind: 'add' })
    expect(firstBlocked(leverGates(under))).toBeNull()
    expect(leverGates(input(read(aave()), { kind: 'add' })).find((x) => x.id === 'cap')!.text).toBe(
      'No supply cap on this reserve',
    )
  })
})

describe('gates: balance and decimals', () => {
  it('names the token and the balance when it is short, and says ETH is not wrapped for WETH', () => {
    const short = leverGates(input(read(aave(), { balance: 120_000_000n })))
    expect(firstBlocked(short)!.text).toBe('Balance 120.00 USDC, short of 460.00 USDC')
    const weth = leverGates(
      input(read(aave(), { decimals: 18, balance: 10n ** 16n }), {
        symbol: 'WETH',
        token: WETH,
        legDecimals: 18,
        amount: 29n * 10n ** 16n,
        kind: 'add',
      }),
    )
    expect(firstBlocked(weth)!.text).toBe(
      'Balance 0.01 WETH, short of 0.29 WETH (ETH is not wrapped here)',
    )
  })
  it('refuses when decimals() disagrees with the leg the amount was converted at', () => {
    expect(firstBlocked(leverGates(input(read(aave(), { decimals: 18 }))))!.text).toBe(
      'USDC reads 18 decimals, the position 6',
    )
  })
})

describe('gates: Compound V3', () => {
  const comet = (o: Partial<Extract<VenueRead, { venue: 'compound' }>> = {}): VenueRead => ({
    venue: 'compound',
    comet: COMET,
    baseToken: USDC,
    supplyPaused: false,
    borrow: 5_000_000_000n,
    capRoom: null,
    ...o,
  })
  it('passes a base repay within the borrow', () => {
    expect(firstBlocked(leverGates(input(read(comet()))))).toBeNull()
  })
  it('blocks paused supply, a non-base token, and a repay above the borrow', () => {
    expect(firstBlocked(leverGates(input(read(comet({ supplyPaused: true })))))!.text).toBe(
      'Supply is paused on this Comet',
    )
    expect(firstBlocked(leverGates(input(read(comet({ baseToken: WETH })))))!.text).toBe(
      "USDC is not this Comet's base asset",
    )
    expect(firstBlocked(leverGates(input(read(comet({ borrow: 100_000_000n })))))!.text).toBe(
      'Repay exceeds the borrow (100.00 USDC)',
    )
  })
  it('blocks collateral over its cap, including a cap of 0', () => {
    const add = (room: bigint) =>
      input(read(comet({ capRoom: room }), { decimals: 18, balance: 10n ** 18n }), {
        kind: 'add',
        symbol: 'WETH',
        token: WETH,
        legDecimals: 18,
        amount: 10n ** 17n,
      })
    expect(firstBlocked(leverGates(add(0n)))!.text).toBe('Supply cap reached: no room for WETH')
    expect(firstBlocked(leverGates(add(10n ** 16n)))!.text).toBe(
      'Over the supply cap: room 0.01 WETH',
    )
    expect(firstBlocked(leverGates(add(10n ** 18n)))).toBeNull()
  })
})

describe('gates: Morpho Blue', () => {
  const params: MorphoMarketParams = {
    loanToken: USDC,
    collateralToken: WETH,
    oracle: OWNER,
    irm: OWNER,
    lltv: 86n * 10n ** 16n,
  }
  const morpho = (o: Partial<Extract<VenueRead, { venue: 'morpho' }>> = {}): VenueRead => ({
    venue: 'morpho',
    params,
    idMatches: true,
    borrowShares: 10n ** 15n,
    sharesForAmount: 10n ** 14n,
    ...o,
  })
  it('passes a repay of the loan token within the borrow shares', () => {
    expect(firstBlocked(leverGates(input(read(morpho()))))).toBeNull()
  })
  it('blocks params that do not hash to the id, the wrong token, and too many shares', () => {
    expect(firstBlocked(leverGates(input(read(morpho({ idMatches: false })))))!.text).toBe(
      'Market params do not hash to the market id',
    )
    expect(
      firstBlocked(leverGates(input(read(morpho()), { token: WETH, symbol: 'WETH' })))!.text,
    ).toBe("WETH is not this market's loan token")
    expect(
      firstBlocked(leverGates(input(read(morpho({ sharesForAmount: 10n ** 16n })))))!.text,
    ).toBe('Repay exceeds the borrow')
    // A top-up must be the collateral token.
    expect(firstBlocked(leverGates(input(read(morpho()), { kind: 'add' })))!.text).toBe(
      "USDC is not this market's collateral token",
    )
  })
})

// ------------------------------------------------------------------ the read itself

type FakeCall = { address: string; functionName: string; args?: readonly unknown[] }

/** A multicall that answers from a table keyed by "address.functionName", and records blocks. */
function fakeClient(
  answer: (c: FakeCall) => unknown,
  blocks: (bigint | undefined)[] = [],
): PublicClient {
  return {
    multicall: async ({
      contracts,
      blockNumber,
    }: {
      contracts: FakeCall[]
      blockNumber?: bigint
    }) => {
      blocks.push(blockNumber)
      return contracts.map((c) => {
        try {
          return { status: 'success', result: answer(c) }
        } catch (error) {
          return { status: 'failure', error }
        }
      })
    },
  } as unknown as PublicClient
}

describe('readLeverChain', () => {
  const A_TOKEN = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c'
  const VDEBT = '0x72e95b8931767c79ba4eee721354d6e99a61d004'
  const aaveAnswer =
    (pool: string, stableToken = '0x0000000000000000000000000000000000000000') =>
    (c: FakeCall): unknown => {
      const key = `${c.address.toLowerCase()}.${c.functionName}`
      if (c.functionName === 'getPool') return pool
      if (key === `${pool}.getReserveData`) {
        return {
          configuration: config({ decimals: 6, supplyCap: 1_000n }),
          aTokenAddress: A_TOKEN,
          stableDebtTokenAddress: stableToken,
          variableDebtTokenAddress: VDEBT,
          accruedToTreasury: 0n,
        }
      }
      if (key === `${VDEBT}.balanceOf`) return 5_000_000_000n
      if (key === `${stableToken}.balanceOf`) return 7n
      if (key === `${A_TOKEN}.scaledTotalSupply`) return 900_000_000n
      if (key === `${pool}.getReserveNormalizedIncome`) return RAY
      if (key === `${USDC}.decimals`) return 6
      if (key === `${USDC}.balanceOf`) return 1_000_000_000n
      if (key === `${USDC}.allowance`) {
        expect(c.args).toEqual([OWNER, pool]) // the allowance read names the resolved pool
        return 3n
      }
      throw new Error(`unexpected ${key}`)
    }

  it('resolves the Aave pool from the provider, pins every read to the block, and builds the action on it', async () => {
    const blocks: (bigint | undefined)[] = []
    const r = await readLeverChain(fakeClient(aaveAnswer(POOL), blocks), {
      protocol: 'aave-v3',
      kind: 'add',
      owner: OWNER,
      token: USDC,
      amount: 50_000_000n,
      block: 123n,
    })
    expect(blocks.every((b) => b === 123n)).toBe(true)
    expect(r.venue).toMatchObject({
      venue: 'aave',
      pool: POOL,
      variableDebt: 5_000_000_000n,
      stableDebt: 0n,
      capRoom: 100_000_000n,
    })
    expect(r).toMatchObject({ decimals: 6, balance: 1_000_000_000n, allowance: 3n })
    expect(r.action).toEqual({
      venue: 'aave',
      kind: 'add',
      pool: POOL,
      asset: USDC,
      amount: 50_000_000n,
      owner: OWNER,
    })
  })

  it("uses Spark's own provider and reads its stable debt token", async () => {
    const STABLE = '0x1111111111111111111111111111111111111111'
    const seen: string[] = []
    const client = fakeClient((c) => {
      if (c.functionName === 'getPool') seen.push(c.address)
      return aaveAnswer(SPARK_POOL, STABLE)(c)
    })
    const r = await readLeverChain(client, {
      protocol: 'spark',
      kind: 'repay',
      owner: OWNER,
      token: USDC,
      amount: 1n,
      block: null,
    })
    expect(seen).toEqual([SPARK_MAINNET_ADDRESSES_PROVIDER])
    expect(r.venue).toMatchObject({ venue: 'aave', pool: SPARK_POOL, stableDebt: 7n })
    const aaveSeen: string[] = []
    await readLeverChain(
      fakeClient((c) => {
        if (c.functionName === 'getPool') aaveSeen.push(c.address)
        return aaveAnswer(POOL)(c)
      }),
      { protocol: 'aave-v3', kind: 'repay', owner: OWNER, token: USDC, amount: 1n, block: null },
    )
    expect(aaveSeen).toEqual([AAVE_V3_MAINNET_ADDRESSES_PROVIDER])
  })

  it('throws, naming the call, when a read fails', async () => {
    const client = fakeClient((c) => {
      if (c.functionName === 'getReserveNormalizedIncome') throw new Error('reverted')
      return aaveAnswer(POOL)(c)
    })
    await expect(
      readLeverChain(client, {
        protocol: 'aave-v3',
        kind: 'repay',
        owner: OWNER,
        token: USDC,
        amount: 1n,
        block: null,
      }),
    ).rejects.toThrow(/getReserveNormalizedIncome/)
  })

  it('re-reads Morpho params and checks they hash back to the id', async () => {
    const params: MorphoMarketParams = {
      loanToken: USDC,
      collateralToken: WETH,
      oracle: OWNER,
      irm: OWNER,
      lltv: 86n * 10n ** 16n,
    }
    const id = morphoMarketId(params)
    const client = fakeClient((c) => {
      switch (c.functionName) {
        case 'idToMarketParams':
          return [params.loanToken, params.collateralToken, params.oracle, params.irm, params.lltv]
        case 'position':
          return [0n, 10n ** 15n, 10n ** 18n]
        case 'market':
          return [0n, 0n, 1_000_000_000n, 10n ** 15n, 0n, 0n]
        case 'decimals':
          return 6
        default:
          return 0n
      }
    })
    const r = await readLeverChain(client, {
      protocol: 'morpho-blue',
      kind: 'repay',
      owner: OWNER,
      token: USDC,
      amount: 100_000_000n,
      marketId: id,
      block: null,
    })
    expect(r.venue).toMatchObject({ venue: 'morpho', idMatches: true, borrowShares: 10n ** 15n })
    expect((r.venue as Extract<VenueRead, { venue: 'morpho' }>).sharesForAmount).toBe(
      morphoSharesDown(100_000_000n, 1_000_000_000n, 10n ** 15n),
    )
    const other = await readLeverChain(client, {
      protocol: 'morpho-blue',
      kind: 'repay',
      owner: OWNER,
      token: USDC,
      amount: 1n,
      marketId: `0x${'ab'.repeat(32)}`,
      block: null,
    })
    expect(other.venue).toMatchObject({ idMatches: false })
  })

  it('reads a Comet named by the position, and its collateral cap', async () => {
    const client = fakeClient((c) => {
      switch (c.functionName) {
        case 'baseToken':
          return USDC
        case 'isSupplyPaused':
          return false
        case 'borrowBalanceOf':
          return 9n
        case 'getAssetInfoByAddress':
          return { supplyCap: 0n }
        case 'totalsCollateral':
          return [5n, 0n]
        case 'decimals':
          return 18
        default:
          return 0n
      }
    })
    const r = await readLeverChain(client, {
      protocol: 'compound-v3',
      kind: 'add',
      owner: OWNER,
      token: WETH,
      amount: 1n,
      marketId: COMET,
      block: null,
    })
    expect(r.venue).toMatchObject({ venue: 'compound', comet: COMET, capRoom: 0n, borrow: 9n })
    expect(r.action).toEqual({
      venue: 'compound',
      kind: 'add',
      comet: COMET,
      asset: WETH,
      amount: 1n,
    })
    await expect(
      readLeverChain(client, {
        protocol: 'compound-v3',
        kind: 'add',
        owner: OWNER,
        token: WETH,
        amount: 1n,
        block: null,
      }),
    ).rejects.toThrow(/no Comet/)
  })
})

describe('cap figures and the amount limit (round 5)', () => {
  // A 500,000 cap at 6 decimals with 499,200 supplied: room 800.
  const capped = (o: Partial<Extract<VenueRead, { venue: 'aave' }>> = {}) =>
    aave({ capRoom: 800_000_000n, supplied: 499_200_000_000n, ...o }, { decimals: 6, supplyCap: 500_000n })
  it('shows cap, supplied and room in one line', () => {
    expect(capLine(capped(), 6, 2, 'USDC')).toBe('cap 500,000 · supplied 499,200.00 · room 800.00 USDC')
    const over = input(read(capped()), { kind: 'add', amount: 1_000_000_000n })
    expect(firstBlocked(leverGates(over))!.text).toBe(
      'Over the supply cap: cap 500,000 · supplied 499,200.00 · room 800.00 USDC',
    )
    const under = input(read(capped()), { kind: 'add', amount: 800_000_000n })
    expect(leverGates(under).find((g) => g.id === 'cap')).toMatchObject({
      ok: true,
      text: 'Under the supply cap: cap 500,000 · supplied 499,200.00 · room 800.00 USDC',
    })
  })
  it('derives supplied from the cap and the room on an older read, and says so at room 0', () => {
    expect(capLine(capped({ supplied: undefined }), 6, 0, 'USDC')).toBe(
      'cap 500,000 · supplied 499,200 · room 800 USDC',
    )
    expect(capLine(capped({ supplied: undefined, capRoom: 0n }), 6, 0, 'USDC')).toBe(
      'cap 500,000 · supplied at or over it · room 0 USDC',
    )
    expect(capLine(aave(), 6, 2, 'USDC')).toBeNull()
  })
  it('limits the amount to the smallest of balance, debt and cap room', () => {
    expect(amountLimit(read(aave(), { balance: 8_912_940n }), 'repay', 'USDC', 2)).toEqual({
      units: 8_912_940n,
      why: 'balance',
      text: 'Wallet holds 8.91 USDC',
    })
    expect(amountLimit(read(aave({ variableDebt: 243_476_454n })), 'repay', 'USDC', 2)).toMatchObject({
      units: 243_476_454n,
      why: 'debt',
      text: 'Variable-rate debt 243.47 USDC',
    })
    expect(amountLimit(read(capped()), 'add', 'USDC', 2)).toMatchObject({ why: 'cap', units: 800_000_000n })
    // No cap: the balance alone. The debt does not limit a top-up.
    expect(amountLimit(read(aave({ variableDebt: 1n })), 'add', 'USDC', 2).why).toBe('balance')
    // A tie goes to the balance: it is the one the reader can change.
    expect(amountLimit(read(aave({ variableDebt: 10_000_000_000n })), 'repay', 'USDC', 2).why).toBe('balance')
  })
})
