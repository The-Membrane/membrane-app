// lib/position-sim/adapters/morphoBlue.ts + morphoDiscovery.ts — which markets an address
// is read in, and what is read there. The Morpho API and the RPC are both stubs: discovery
// is only the market LIST; every figure comes from the stub chain at one pinned block, and
// the expected figures are recomputed here with Morpho's own formulas, not the adapter's.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { emptyReadLine } from '@/components/Simulator/emptyRead'
import { buildPositionView, lineTag, noneCopy, pageState, readStatus, statusSentence, statusWord } from '@/components/PositionV0/viewModel'
import { ADAPTERS, PartialReadError, runAdapter } from '@/lib/position-sim/adapters'
import { createMorphoBlueAdapter, MORPHO_BLUE_MAINNET, type MorphoBlueDeps } from '@/lib/position-sim/adapters/morphoBlue'
import {
  COMMITTED_MARKET_LIST_URL,
  EXPOSURE_MARKET_IDS,
  MORPHO_API_BACKOFF_MS,
  MORPHO_API_URL,
  MORPHO_MAX_MARKETS,
  createMorphoDiscovery,
} from '@/lib/position-sim/adapters/morphoDiscovery'
import { DEFILLAMA_PRICES_URL, ORACLE_REFERENCE_BAND, checkOracle, defillamaUsdPrices } from '@/lib/position-sim/adapters/referencePrice'
import type { AdapterResult, ProtocolId } from '@/lib/position-sim/types'
import { ACCRUAL_BUFFER_HOURS, FALLBACK_BORROW_APR, accrualFactor } from '@/lib/position/reverseSolve'
import { TOUCH_TABLE } from '@/lib/position/touchHistory'

// ------------------------------------------------------------------ fixtures

type Hex = `0x${string}`
const USER = '0x00000000000000000000000000000000000000f1' as Hex
const BLOCK = 26_207_297n
const TS = 1_792_180_151n
const WAD = 10n ** 18n

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Hex
const USDS = '0xdc035d45d973e3ec169d2276ddab16f1e407384f' as Hex
const EURCV = '0x5f7827fdeb7c20b443265fc2f40845b715385ff2' as Hex
const WEETH = '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee' as Hex
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' as Hex
const ZERO = '0x0000000000000000000000000000000000000000' as Hex
const IRM = '0x870ac11d48b15db9a138cf899d20f13f79ba00bc' as Hex
const ORACLE = '0x00000000000000000000000000000000000000a1' as Hex
const ORACLE_WETH_USDS = '0x00000000000000000000000000000000000000a2' as Hex

/** The committed Oct 10 2025 list, as the page serves it. */
const COMMITTED = readFileSync(join(process.cwd(), 'public', 'data', 'oct10-2025', 'protocols.json'), 'utf8')
const COMMITTED_IDS = Object.keys(JSON.parse(COMMITTED).morphoBlue.markets).map((k) => k.toLowerCase())

/** weETH/USDC 86% — a real mainnet market (0x85252bb8…) NOT in the committed list. */
const NEW = '0x85252bb8485c99bba46fe149c7dd2aad83672640f53c630890673cf1848ba16e' as Hex
/** A market the API lists but the address has left. */
const CLOSED = '0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64' as Hex
/** A curator-exposure market that is not in the committed list either. */
const EXPOSURE_ONLY = EXPOSURE_MARKET_IDS.find((id) => !COMMITTED_IDS.includes(id)) as Hex
const IDLE = '0x00000000000000000000000000000000000000000000000000000000000000e1' as Hex
const UNPRICED = '0x00000000000000000000000000000000000000000000000000000000000000e2' as Hex
const WETH_USDS = '0x12cacbbd1c88513cce13d54927f5f1301335779353817bc5e791e71d200f2199' as Hex
/** WETH/USDC 91.5%, no IRM: its oracle quotes WETH at ~$4.7T (mainnet, 2026-10-16). */
const BAD_ORACLE_MARKET = '0xddac43c721a67ea9f19b1c57d2de12039c99f3f271c90123f7d8fc9edb591ee6' as Hex
const ORACLE_BAD = '0x00000000000000000000000000000000000000a3' as Hex

interface MarketFixture {
  words: bigint[] // totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee
  params: [Hex, Hex, Hex, Hex, bigint] // loan, collateral, oracle, irm, lltv
  price?: bigint
  rate?: bigint | 'revert'
}

const LLTV_86 = 860_000_000_000_000_000n
const usdcMarket = (collateral: Hex, rate: bigint | 'revert' = 1_627_110_572n): MarketFixture => ({
  words: [50_000_000_000_000n, 48_000_000_000_000_000_000n, 40_000_000_000_000n, 39_000_000_000_000_000_000n, TS - 600n, 0n],
  params: [USDC, collateral, ORACLE, IRM, LLTV_86],
  // 2,668.656 USDC per weETH at the 1e36 · 10^(6 − 18) scale.
  price: 2_668_656_000_000_000_000_000_000_000n,
  rate,
})

const MARKETS: Record<string, MarketFixture> = {
  [NEW]: usdcMarket(WEETH),
  [CLOSED]: usdcMarket(WETH),
  [EXPOSURE_ONLY]: usdcMarket(WETH),
  [IDLE]: { words: [9_000_000_000n, 9_000_000_000_000_000n, 0n, 0n, TS - 86_400n, 0n], params: [USDC, ZERO, ZERO, ZERO, 0n] },
  [UNPRICED]: { ...usdcMarket(WETH), params: [EURCV, WETH, ORACLE, IRM, LLTV_86] },
  [BAD_ORACLE_MARKET]: {
    words: [102_000_000_000_000n, 102_000_000_000_000_000_000n, 101_958_151_000_000n, 101_958_151_000_000_000_000n, TS - 100n, 0n],
    params: [USDC, WETH, ORACLE_BAD, ZERO, 915_000_000_000_000_000n],
    // 4.7e12 USDC per WETH at the 1e36 · 10^(6 − 18) scale.
    price: 4_700_000_000_000n * 10n ** 24n,
  },
  [WETH_USDS]: {
    words: [10_000_000_000_000_000_000_000n, 9_000_000_000_000_000_000_000_000_000n, 3_000_000_000_000_000_000_000n, 2_900_000_000_000_000_000_000_000_000n, TS - 121_392n, 0n],
    params: [USDS, WETH, ORACLE_WETH_USDS, IRM, LLTV_86],
    // 2,413.25363296 USDS per WETH at the 1e36 · 10^(18 − 18) scale.
    price: 2_413_253_632_960_000_000_000_000_000_000_000_000_000n,
    rate: 2_423_547_601n,
  },
}

const DECIMALS: Record<string, number> = { [USDC]: 6, [USDS]: 18, [EURCV]: 18, [WEETH]: 18, [WETH]: 18 }
const SYMBOLS: Record<string, string> = { [USDC]: 'USDC', [USDS]: 'USDS', [EURCV]: 'EURCV', [WEETH]: 'weETH', [WETH]: 'WETH' }

type Position = [bigint, bigint, bigint] // supplyShares, borrowShares, collateral
interface Call {
  address: string
  functionName: string
  args?: readonly unknown[]
}

/** A stub viem client answering from the fixtures; records every call and block it saw. */
function chain(positions: Record<string, Position>) {
  const seen = { blocks: new Set<bigint | undefined>(), calls: [] as Call[] }
  const answer = (c: Call): unknown => {
    const id = String(c.args?.[0] ?? '').toLowerCase()
    const m = MARKETS[id]
    switch (c.functionName) {
      case 'position':
        return positions[id] ?? [0n, 0n, 0n]
      case 'market':
        return m?.words
      case 'idToMarketParams':
        return m?.params
      case 'getCurrentBlockTimestamp':
        return TS
      case 'decimals':
        return DECIMALS[c.address.toLowerCase()]
      case 'symbol':
        return SYMBOLS[c.address.toLowerCase()]
      case 'price':
        return Object.values(MARKETS).find((x) => x.price !== undefined && x.params[2] === c.address)?.price
      case 'borrowRateView': {
        const params = c.args?.[0] as { loanToken: string; collateralToken: string }
        const hit = Object.values(MARKETS).find((x) => x.params[0] === params.loanToken && x.params[1] === params.collateralToken)
        return hit?.rate === 'revert' ? undefined : hit?.rate
      }
      default:
        return undefined
    }
  }
  const client = {
    getBlockNumber: async () => BLOCK,
    multicall: async ({ contracts, blockNumber }: { contracts: Call[]; blockNumber?: bigint }) => {
      seen.blocks.add(blockNumber)
      return contracts.map((c) => {
        seen.calls.push(c)
        const r = answer(c)
        return r === undefined ? { status: 'failure', error: new Error(`${c.functionName} reverted`) } : { status: 'success', result: r }
      })
    },
  }
  return { client: () => client as never, seen }
}

interface ApiEntry {
  id: Hex
  state?: { supplyShares: string | number; borrowShares: string | number; collateral: string | number }
}

/** A stub fetch: the Morpho API answers `api` (or fails), the committed list is served from disk. */
function web(api: ApiEntry[] | { status: number } | 'hang') {
  const asked: { url: string; body?: string }[] = []
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    asked.push({ url, body: init?.body as string | undefined })
    if (url === COMMITTED_MARKET_LIST_URL) return new Response(COMMITTED, { status: 200 })
    if (url !== MORPHO_API_URL) return new Response('not found', { status: 404 })
    if (api === 'hang') return new Promise<Response>(() => {})
    if (!Array.isArray(api)) return new Response('no', { status: api.status })
    const marketPositions = api.map((e) => ({
      market: { marketId: e.id, morphoBlue: { address: MORPHO_BLUE_MAINNET }, loanAsset: { symbol: 'API-LOAN' }, collateralAsset: { symbol: 'API-COLL' } },
      state: e.state ?? { supplyShares: 0, borrowShares: '1', collateral: '1' },
    }))
    return new Response(JSON.stringify({ data: { userByAddress: { marketPositions } } }), { status: 200 })
  }) as typeof fetch
  return { fetch: fetchStub, asked }
}

const usdPrices = (prices: Record<string, number>) => async (tokens: Hex[]) =>
  Object.fromEntries(tokens.filter((t) => prices[t] !== undefined).map((t) => [t, prices[t]]))

/** The Aave V3 oracle at the block, stubbed: market prices for the fixtures' tokens. */
const AAVE = { [WEETH]: 2661.317, [WETH]: 2413.25, [USDS]: 0.99983561 }

/** An adapter on stubs only: no RPC, no Morpho API, no Aave, no DefiLlama from the network. */
const make = (deps: Partial<MorphoBlueDeps>) =>
  createMorphoBlueAdapter({
    now: () => 0,
    usdPrices: usdPrices(AAVE),
    referencePrices: async () => ({ prices: {}, error: null }),
    ...deps,
  })

// ------------------------------------------------------------------ Morpho's math, again

const mulDivUp = (x: bigint, y: bigint, d: bigint) => (x * y + d - 1n) / d
const wMulDown = (x: bigint, y: bigint) => (x * y) / WAD
/** MathLib.wTaylorCompounded. */
function taylor(x: bigint, n: bigint) {
  const a = x * n
  const b = (a * a) / (2n * WAD)
  return a + b + (b * a) / (3n * WAD)
}
/** Borrowed assets after Morpho's _accrueInterest at TS, rounded up (SharesMathLib.toAssetsUp). */
function borrowedAt(m: MarketFixture, shares: bigint) {
  const [, , tba, tbs, last] = m.words
  const interest = wMulDown(tba, taylor(m.rate as bigint, TS - last))
  return mulDivUp(shares, tba + interest + 1n, tbs + 10n ** 6n)
}
/** maxBorrow / borrowed, as _isHealthy compares them. */
function healthFactor(m: MarketFixture, collateral: bigint, borrowed: bigint) {
  const maxBorrow = wMulDown((collateral * (m.price as bigint)) / 10n ** 36n, m.params[4])
  return Number((maxBorrow * WAD) / borrowed) / 1e18
}

const close = (a: number, b: number, rel = 1e-12) => expect(Math.abs(a / b - 1)).toBeLessThan(rel)

// ------------------------------------------------------------------ discovery

describe('Morpho Blue discovery', () => {
  it('reads the markets the Morpho API lists — one the committed list never had — on-chain, at one block', async () => {
    expect(COMMITTED_IDS).not.toContain(NEW)
    const borrowShares = 290_000_000_000_000_000n
    const collateral = 200n * WAD
    const { client, seen } = chain({ [NEW]: [0n, borrowShares, collateral] })
    const w = web([{ id: NEW }, { id: CLOSED, state: { supplyShares: 0, borrowShares: 0, collateral: 0 } }])
    const adapter = make({ client, fetch: w.fetch, now: () => 1_792_180_151_000 })

    const positions = await adapter.read(USER) // complete discovery: a plain result, no throw
    expect(positions).toHaveLength(1)
    const p = positions[0]
    expect(p).toMatchObject({ protocol: 'morpho-blue', label: 'Morpho · weETH/USDC 86%', marketId: NEW, status: 'borrowing' })

    // The API was asked once, for this address on chain 1. The scan read its markets first,
    // then every known market it did not list (a position it has not indexed yet still shows).
    const body = JSON.parse(w.asked.find((a) => a.url === MORPHO_API_URL)?.body ?? '{}')
    expect(body.variables).toEqual({ address: USER, chainId: 1 })
    const scanned = seen.calls.filter((c) => c.functionName === 'position').map((c) => c.args?.[0])
    const known = new Set([...COMMITTED_IDS, ...EXPOSURE_MARKET_IDS])
    expect(scanned.slice(0, 2)).toEqual([NEW, CLOSED])
    expect(new Set(scanned)).toEqual(new Set([NEW, CLOSED, ...known]))
    expect(scanned).toHaveLength(new Set(scanned).size)
    expect([...seen.blocks]).toEqual([BLOCK])

    // Every figure from the chain: debt accrued to the block like _accrueInterest, HF like _isHealthy.
    const m = MARKETS[NEW]
    const borrowed = borrowedAt(m, borrowShares)
    expect(p.debt[0].amount).toBe(Number(borrowed) / 1e6)
    close(p.healthFactor, healthFactor(m, collateral, borrowed))
    expect(p.collateral[0]).toMatchObject({ symbol: 'weETH', amount: 200, liquidationThreshold: 0.86 })
    close(p.collateral[0].priceUsd, 2668.656)
    expect(p.debt[0].borrowApr).toBeCloseTo((1_627_110_572 * 31_536_000) / 1e18, 15)
    expect(p.provenance.block).toBe(Number(BLOCK))
    expect(p.provenance.detail).toMatch(/Markets as indexed by the Morpho API .* plus a scan of the known-market list/)
    expect(p.oracleCheck).toMatchObject({ status: 'ok', symbol: 'weETH', quote: 'USDC', referenceUsd: 2661.317, referenceSource: 'Aave V3 oracle at this block' })
    expect(p.provenance.detail).toMatch(/borrowRateView at this block/)

    // The registry: an ordinary 'ok', and the page's position view uses the real rate.
    const r = await runAdapter(adapter, USER)
    expect(r.status).toBe('ok')
    expect(r.discovery).toBeUndefined()
  })

  it('API failure → the known-market list, PARTIAL: nothing found is "incomplete", never "no position found"', async () => {
    const { client, seen } = chain({})
    const adapter = make({ client, fetch: web({ status: 500 }).fetch })
    const r = await runAdapter(adapter, USER)
    const known = new Set([...COMMITTED_IDS, ...EXPOSURE_MARKET_IDS]).size
    expect(r.status).toBe('incomplete')
    expect(r.positions).toEqual([])
    expect(r.discovery).toEqual({ complete: false, source: 'known-market list', checked: known, reason: 'Morpho API failed: HTTP 500' })
    expect(r.message).toMatch(/^no position in the markets checked: only \d+ markets from the known-market list were checked/)
    expect(r.message).not.toMatch(/no position found/)
    expect(seen.calls.filter((c) => c.functionName === 'position')).toHaveLength(known)

    // The page: the status line and the none-state say what was checked, never "none found".
    const order = ADAPTERS.map((a) => ({ id: a.id, label: a.label }))
    const results: Partial<Record<ProtocolId, AdapterResult>> = {
      'aave-v3': { ...r, protocol: 'aave-v3', status: 'empty', discovery: undefined, message: 'no position found' },
      spark: { ...r, protocol: 'spark', status: 'empty', discovery: undefined },
      'morpho-blue': r,
      'compound-v3': { ...r, protocol: 'compound-v3', status: 'empty', discovery: undefined },
      fluid: { ...r, protocol: 'fluid', status: 'unsupported', discovery: undefined },
    }
    const items = readStatus(order, results)
    expect(pageState(true, items, results, TOUCH_TABLE).kind).toBe('none')
    expect(statusWord(items[2])).toBe(`Morpho Blue read · ${known} known markets only`)
    expect(statusSentence(items)).toBe(`Aave V3 / Spark / Morpho Blue (${known} known markets only) / Compound V3 read · Fluid not supported yet`)
    const none = noneCopy(items)
    expect(none.headline).toBe('Not every market could be checked')
    expect(none.nothingOn).toEqual(['Aave V3', 'Spark', 'Compound V3'])
    expect(none.partial).toEqual([
      `Morpho Blue: nothing in the markets checked; only ${known} markets from the known-market list were checked (Morpho API failed: HTTP 500); a position in any other market would not show.`,
    ])
    // A complete empty read is the only "No open position found"; a failed venue is not one either.
    const complete = { ...results, 'morpho-blue': { ...r, status: 'empty' as const, discovery: undefined } }
    expect(noneCopy(readStatus(order, complete)).headline).toBe('No open position found')
    const failed = { ...results, 'morpho-blue': { ...r, status: 'error' as const, discovery: undefined, message: 'rpc down' } }
    expect(noneCopy(readStatus(order, failed)).headline).toBe('Not every venue could be read')
  })

  it('the fallback finds a market only the curator exposure snapshot names; the read is ok but named partial', async () => {
    expect(EXPOSURE_ONLY).toBeDefined()
    const { client } = chain({ [EXPOSURE_ONLY]: [0n, 290_000_000_000_000_000n, 200n * WAD] })
    const adapter = make({ client, fetch: web({ status: 429 }).fetch })
    await expect(adapter.read(USER)).rejects.toBeInstanceOf(PartialReadError)
    const r = await runAdapter(adapter, USER)
    expect(r.status).toBe('ok')
    expect(r.positions.map((p) => p.marketId)).toEqual([EXPOSURE_ONLY])
    expect(r.discovery?.complete).toBe(false)
    expect(r.positions[0].provenance.detail).toMatch(/Discovery is partial/)
    const items = readStatus(ADAPTERS.map((a) => ({ id: a.id, label: a.label })), { 'morpho-blue': r })
    expect(statusWord(items[2])).toMatch(/^Morpho Blue read · 1 found · \d+ known markets only$/)
  })

  it('a position the API has not indexed yet still shows when its market is known; the stamp says "as indexed"', async () => {
    const { client } = chain({ [EXPOSURE_ONLY]: [0n, 290_000_000_000_000_000n, 200n * WAD] })
    const r = await runAdapter(make({ client, fetch: web([]).fetch }), USER)
    expect(r.status).toBe('ok')
    expect(r.discovery).toBeUndefined() // complete, as far as the API's index and the known list go
    expect(r.positions.map((p) => p.marketId)).toEqual([EXPOSURE_ONLY])
    expect(r.positions[0].provenance.detail).toMatch(
      /Markets as indexed by the Morpho API .* 0 the address has touched, 0 open by its index — plus a scan of the known-market list .*: \d+ in all, \d+ of them not listed by the API\. A position the API has not indexed yet, in a market outside the known list, would not show\./,
    )
  })

  it('a malformed market id from the API makes the read partial, not silently shorter', async () => {
    const malformed = [{ id: NEW }, { id: 'not-a-market-id' as Hex }]
    const d = await createMorphoDiscovery({ fetch: web(malformed).fetch, now: () => 0 })(USER)
    expect(d).toMatchObject({ complete: false, source: 'Morpho API index and known-market list', reason: '1 market ids from the API were malformed' })
    expect(d.markets[0].id).toBe(NEW)
    const { client } = chain({})
    const r = await runAdapter(make({ client, fetch: web(malformed).fetch }), USER)
    expect(r.status).toBe('incomplete')
    const items = readStatus(ADAPTERS.map((a) => ({ id: a.id, label: a.label })), { 'morpho-blue': r })
    expect(statusWord(items[2])).toBe(`Morpho Blue read · ${d.markets.length} markets checked, list partial`)
  })

  it('a timeout is a failure, not a wait', async () => {
    const discover = createMorphoDiscovery({ fetch: web('hang').fetch, now: () => 0, timeoutMs: 20 })
    const d = await discover(USER)
    expect(d).toMatchObject({ complete: false, source: 'known-market list', reason: 'Morpho API failed: no answer in 0.02 s' })
  })

  it('after a 429 the API is not asked again until its ten-minute pause has passed', async () => {
    let now = 1_000_000
    const w = web({ status: 429 })
    const discover = createMorphoDiscovery({ fetch: w.fetch, now: () => now })
    const apiCalls = () => w.asked.filter((a) => a.url === MORPHO_API_URL).length
    expect((await discover(USER)).reason).toBe('Morpho API failed: HTTP 429, rate-limited')
    now += MORPHO_API_BACKOFF_MS - 1
    expect((await discover(USER)).reason).toMatch(/^Morpho API is paused after a rate limit until \d\d:\d\d UTC$/)
    expect(apiCalls()).toBe(1)
    now += 1
    await discover(USER)
    expect(apiCalls()).toBe(2)
  })

  it('caps the markets read per address, borrowers first, and calls a cut open market partial', async () => {
    const open = Array.from({ length: MORPHO_MAX_MARKETS + 6 }, (_, i) => ({
      id: `0x${(i + 1).toString(16).padStart(64, '0')}` as Hex,
      state: { supplyShares: '5', borrowShares: 0, collateral: 0 },
    }))
    const borrower = { id: NEW, state: { supplyShares: 0, borrowShares: '7', collateral: '9' } }
    const d = await createMorphoDiscovery({ fetch: web([...open, borrower]).fetch, now: () => 0 })(USER)
    // The API's markets are capped (the known-market list is scanned beside them, uncapped).
    const knownIds = new Set<string>([...COMMITTED_IDS, ...EXPOSURE_MARKET_IDS])
    const fromApi = d.markets.filter((m) => !knownIds.has(m.id) || m.id === NEW)
    expect(fromApi).toHaveLength(MORPHO_MAX_MARKETS)
    expect(d.markets[0].id).toBe(NEW)
    expect(d.markets.map((m) => m.id)).not.toContain(open[open.length - 1].id)
    expect(d.markets).toHaveLength(MORPHO_MAX_MARKETS - 1 + knownIds.size)
    expect(d).toMatchObject({
      complete: false,
      source: 'Morpho API index and known-market list',
      reason: `7 more open markets past the cap of ${MORPHO_MAX_MARKETS}`,
    })
    // Closed markets past the cap do not make it partial: the API says the address left them.
    const closed = open.map((e) => ({ ...e, state: { supplyShares: 0, borrowShares: 0, collateral: 0 } }))
    const d2 = await createMorphoDiscovery({ fetch: web([borrower, ...closed]).fetch, now: () => 0 })(USER)
    expect(d2.complete).toBe(true)
    expect(d2.markets.filter((m) => !knownIds.has(m.id) || m.id === NEW)).toHaveLength(MORPHO_MAX_MARKETS)
  })
})

// ------------------------------------------------------------------ what is read

describe('Morpho Blue positions', () => {
  it('a supply-only position comes back with its status, its supplied leg and no line — not "none found"', async () => {
    const shares = 48_000_000_000_000_000n
    const { client, seen } = chain({ [NEW]: [shares, 0n, 0n], [IDLE]: [9_000_000_000_000_000n, 0n, 0n] })
    const adapter = make({ client, fetch: web([{ id: NEW }, { id: IDLE }]).fetch })
    const positions = await adapter.read(USER)
    const lent = positions.find((p) => p.marketId === NEW)
    const idle = positions.find((p) => p.marketId === IDLE)
    expect(lent).toMatchObject({ status: 'supply-only', collateral: [], debt: [], totalDebtUsd: 0, healthFactor: Number.POSITIVE_INFINITY })
    // toAssetsDown on the accrued totals (fee 0: supply grows by the borrow interest).
    const m = MARKETS[NEW]
    const interest = wMulDown(m.words[2], taylor(m.rate as bigint, TS - m.words[4]))
    const supplied = (shares * (m.words[0] + interest + 1n)) / (m.words[1] + 10n ** 6n)
    expect(lent?.supplied).toMatchObject([{ symbol: 'USDC', address: USDC, decimals: 6, amount: Number(supplied) / 1e6, priceUsd: 1, valueUsd: Number(supplied) / 1e6, supplyApr: null, supplyAprFeeBasis: 'unknown' }])
    // An idle market (no collateral token, no IRM): no oracle is read, the rate is 0, no accrual.
    expect(idle).toMatchObject({ label: 'Morpho · USDC idle market', status: 'supply-only' })
    expect(idle?.supplied?.[0].amount).toBe(Number((9_000_000_000_000_000n * (9_000_000_000n + 1n)) / (9_000_000_000_000_000n + 10n ** 6n)) / 1e6)
    expect(seen.calls.filter((c) => c.functionName === 'price')).toHaveLength(0)

    // The page shows its no-debt state for it, and it is a position, not "none".
    const v = buildPositionView(lent!, TOUCH_TABLE)
    expect(v.hero.kind).toBe('no-debt')
    expect(lineTag(v)).toBe('lending only')
    expect(v.priceSource).toBe('USDC taken as $1')
    // Honest: no line, but not beyond loss — bad debt is written off against lenders' supply.
    expect(lent?.provenance.detail).toMatch(/It has no liquidation line, but bad debt a borrower's liquidation leaves in this market is written off against lenders' supply\./)
    expect(lent?.provenance.detail).not.toMatch(/no liquidation touches/)
    const r = await runAdapter(adapter, USER)
    // The simulator: a pure lender is a lending-only line, not "No open position found".
    expect(emptyReadLine([r])).toBe(
      'Lending only (Morpho · weETH/USDC 86%, Morpho · USDC idle market): no liquidation line to simulate. Bad debt in a market is shared by its lenders.',
    )
    expect(emptyReadLine([{ ...r, positions: [] }])).toBe('No open position found for this address.')
    expect(pageState(true, readStatus([{ id: 'morpho-blue', label: 'Morpho Blue' }], { 'morpho-blue': r }), { 'morpho-blue': r }, TOUCH_TABLE).kind).toBe('positions')
  })

  it('the 24 h buffer accrues at the IRM rate; only a failed IRM read falls back, and the provenance says so', async () => {
    const shares = 290_000_000_000_000_000n
    const read = async (rate: bigint | 'revert') => {
      MARKETS[NEW] = usdcMarket(WEETH, rate)
      const { client } = chain({ [NEW]: [0n, shares, 200n * WAD] })
      return (await make({ client, fetch: web([{ id: NEW }]).fetch }).read(USER)).find((p) => p.marketId === NEW)!
    }
    try {
      const real = await read(1_627_110_572n)
      const apr = real.debt[0].borrowApr as number
      expect(accrualFactor(apr)).toBe(Math.exp(apr * (ACCRUAL_BUFFER_HOURS / 8760)))
      expect(accrualFactor(apr)).not.toBe(accrualFactor(null))

      const failed = await read('revert')
      expect(failed.debt[0].borrowApr).toBeNull()
      expect(accrualFactor(failed.debt[0].borrowApr)).toBe(Math.exp(FALLBACK_BORROW_APR * (ACCRUAL_BUFFER_HOURS / 8760)))
      expect(failed.provenance.detail).toMatch(/Borrow rate NOT read: borrowRateView on IRM .* failed/)
      expect(failed.provenance.detail).toMatch(/accrual buffer uses its fallback rate/)
      // Without a rate there is no accrual: the stored debt, rounded up.
      const [, , tba, tbs] = MARKETS[NEW].words
      expect(failed.debt[0].amount).toBe(Number(mulDivUp(shares, tba + 1n, tbs + 10n ** 6n)) / 1e6)
    } finally {
      MARKETS[NEW] = usdcMarket(WEETH)
    }
  })

  it('a non-stable loan token is priced by the Aave oracle at the block; an unpriced one skips only its market', async () => {
    const coll = 1_427_709_987_489_870_863n
    const shares = 1_503_000_000_000_000_000_000_000_000n
    const { client } = chain({ [WETH_USDS]: [0n, shares, coll], [UNPRICED]: [0n, 290_000_000_000_000_000n, 2n * WAD] })
    const blocks: bigint[] = []
    const adapter = make({
      client,
      fetch: web([{ id: WETH_USDS }, { id: UNPRICED }]).fetch,
      usdPrices: async (tokens, block) => {
        blocks.push(block)
        return usdPrices(AAVE)(tokens)
      },
    })
    const r = await runAdapter(adapter, USER)
    expect(r.status).toBe('ok')
    expect(blocks).toEqual([BLOCK])
    expect(r.skipped).toEqual([
      {
        market: 'WETH/EURCV 86%',
        reason: `no USD price for its loan token EURCV (${EURCV}): Morpho's oracle quotes collateral in loan-token units and the Aave V3 oracle does not list this token. Refusing to assume a price.`,
      },
    ])
    const p = r.positions[0]
    const m = MARKETS[WETH_USDS]
    const borrowed = borrowedAt(m, shares)
    expect(p.label).toBe('Morpho · WETH/USDS 86%')
    expect(p.debt[0]).toMatchObject({ symbol: 'USDS', amount: Number(borrowed) / 1e18, priceUsd: 0.99983561 })
    close(p.healthFactor, healthFactor(m, coll, borrowed))
    expect(p.provenance.detail).toMatch(/Loan token USDS priced at \$0\.99983561 from the Aave V3 oracle/)
    expect(buildPositionView(p, TOUCH_TABLE).priceSource).toBe('Morpho market oracle, USDS priced by the Aave V3 oracle')
  })
})

// ------------------------------------------------------------------ the oracle against the market

describe('Morpho oracle sanity check', () => {
  const borrowShares = MARKETS[BAD_ORACLE_MARKET].words[3]
  const read = async (deps: Partial<MorphoBlueDeps> = {}, id: Hex = BAD_ORACLE_MARKET, pos: Position = [0n, borrowShares, 10n ** 15n]) => {
    const { client } = chain({ [id]: pos })
    return (await make({ client, fetch: web([{ id }]).fetch, ...deps }).read(USER)).find((p) => p.marketId === id)!
  }

  it('the $4.7T WETH oracle disagrees with the market: the line stays in its own terms, nothing is forecast on it', async () => {
    const p = await read()
    expect(p.oracleCheck).toMatchObject({
      status: 'disagrees',
      symbol: 'WETH',
      quote: 'USDC',
      oraclePrice: 4.7e12,
      oraclePriceUsd: 4.7e12,
      referenceUsd: 2413.25,
      referenceSource: 'Aave V3 oracle at this block',
      band: { min: 0.5, max: 2 },
    })
    close(p.oracleCheck!.ratio!, 4.7e12 / 2413.25)
    expect(p.provenance.detail).toMatch(/oracle price disagrees with market: WETH \$4\.70e\+12 by the oracle vs \$2,413\.25 \(Aave V3 oracle at this block\)\. The line holds only in the oracle's own terms\./)

    const v = buildPositionView(p, TOUCH_TABLE)
    expect(v.hero.kind).toBe('line')
    if (v.hero.kind !== 'line') return
    // The line in the oracle's quote (USDC per WETH): debt / (collateral · lltv), here ~1.11e11.
    expect(v.oracleFlag?.line?.value).toBeCloseTo(v.hero.priceLine, 6)
    close(v.oracleFlag!.line!.value, p.totalDebtUsd / (0.001 * 0.915), 1e-9)
    expect(v.oracleFlag?.line?.now).toBeCloseTo(4.7e12, 0)
    // Withheld: the forecast (and with it every lever's chance) and the alert price.
    expect(v.forecast).toBeNull()
    expect(v.forecastAbsent).toBe('Oracle price disagrees with market.')
    expect(v.alert).toBeNull()
    expect(lineTag(v)).toBe(`line −${v.hero.distancePct}% · oracle disagrees with market`)
    // The same position without the flag would have been forecast and alerted: the flag withholds them.
    const unflagged = buildPositionView({ ...p, oracleCheck: undefined }, TOUCH_TABLE)
    expect(unflagged.forecast).not.toBeNull()
    expect(unflagged.alert?.referencePrice).toBeCloseTo(4.7e12, 0)
  })

  it('no reference anywhere: "unchecked", named with why, and withheld the same way', async () => {
    const p = await read({ usdPrices: usdPrices({}), referencePrices: async () => ({ prices: {}, error: 'DefiLlama HTTP 429' }) }, NEW, [0n, 290_000_000_000_000_000n, 200n * WAD])
    expect(p.oracleCheck).toMatchObject({ status: 'unchecked', referenceUsd: null, ratio: null })
    expect(p.oracleCheck?.referenceSource).toBe('the Aave V3 oracle does not list it; DefiLlama HTTP 429')
    const v = buildPositionView(p, TOUCH_TABLE)
    expect(v.forecast).toBeNull()
    expect(v.forecastAbsent).toBe('Oracle price unchecked: no market reference.')
    expect(v.alert).toBeNull()
    expect(lineTag(v)).toMatch(/ · oracle unchecked$/)
  })

  it('a token Aave does not list is checked against DefiLlama; within the band the forecast stands', async () => {
    const asked: Hex[][] = []
    const p = await read(
      {
        usdPrices: usdPrices({}),
        referencePrices: async (tokens) => {
          asked.push(tokens)
          return { prices: { [WEETH]: 2661.317 }, error: null }
        },
      },
      NEW,
      [0n, 290_000_000_000_000_000n, 200n * WAD],
    )
    expect(asked).toEqual([[WEETH]])
    expect(p.oracleCheck).toMatchObject({ status: 'ok', referenceUsd: 2661.317, referenceSource: 'DefiLlama current price' })
    const v = buildPositionView(p, TOUCH_TABLE)
    expect(v.oracleFlag).toBeNull()
    expect(v.forecast).not.toBeNull()
  })

  it('the band is 0.5–2×, inclusive', () => {
    const base = { symbol: 'WETH', quote: 'USDC', oraclePrice: 0, referenceUsd: 100, referenceSource: 'x' }
    expect(ORACLE_REFERENCE_BAND).toEqual({ min: 0.5, max: 2 })
    expect(checkOracle({ ...base, oraclePriceUsd: 200 }).status).toBe('ok')
    expect(checkOracle({ ...base, oraclePriceUsd: 50 }).status).toBe('ok')
    expect(checkOracle({ ...base, oraclePriceUsd: 201 }).status).toBe('disagrees')
    expect(checkOracle({ ...base, oraclePriceUsd: 49 }).status).toBe('disagrees')
    expect(checkOracle({ ...base, oraclePriceUsd: 100, referenceUsd: null }).status).toBe('unchecked')
  })

  it('DefiLlama: token addresses only, prices by address, a failure or a stall is named', async () => {
    const urls: string[] = []
    const ok = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response(JSON.stringify({ coins: { [`ethereum:${WEETH}`]: { price: 2661.3, confidence: 0.99 } } }), { status: 200 })
    }) as typeof fetch
    expect(await defillamaUsdPrices([WEETH, WETH], ok)).toEqual({ prices: { [WEETH]: 2661.3 }, error: null })
    expect(urls).toEqual([`${DEFILLAMA_PRICES_URL}ethereum:${WEETH},ethereum:${WETH}`])
    const down = (async () => new Response('no', { status: 500 })) as typeof fetch
    expect(await defillamaUsdPrices([WEETH], down)).toEqual({ prices: {}, error: 'DefiLlama HTTP 500' })
    const stall = (() => new Promise<Response>(() => {})) as typeof fetch
    expect(await defillamaUsdPrices([WEETH], stall, 20)).toEqual({ prices: {}, error: 'DefiLlama no answer in 0.02 s' })
  })
})

// ------------------------------------------------------------------ the accrual buffer

describe('accrual buffer', () => {
  it('compounds: e^(apr·h/8760), never under per-second accrual, where the linear factor was', () => {
    for (const apr of [0.05, 0.8, 8]) {
      const h = ACCRUAL_BUFFER_HOURS
      const perSecond = (1 + apr / 31_536_000) ** (h * 3600)
      expect(accrualFactor(apr)).toBe(Math.exp((apr * h) / 8760))
      expect(accrualFactor(apr)).toBeGreaterThanOrEqual(perSecond - 1e-12)
      // The old linear factor fell short of per-second accrual: rows solved on it landed short.
      expect(1 + (apr * h) / 8760).toBeLessThan(perSecond)
    }
  })
})
