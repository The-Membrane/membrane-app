/**
 * The live engine's scripted scenario, shared by the engine and Postgres tests (see
 * wavefrontLiveEngine.test.ts for what it holds). Base-like 2 s blocks; minute m starts at
 * EPOCH + 60 m; WETH follows PATH by minute.
 */
import {
  CHAIN_CONFIG,
  LiveEngine,
  MemorySink,
  SimClock,
  clockHead,
  type EngineOptions,
  type HeadFn,
  type LiveRecord,
  type StreamSink,
} from '@/lib/wavefront/live'
import { FakeChain, aaveLog, morphoLog, type FakeChainSpec, type FakeReserve } from './wavefrontLiveFake'

export const EPOCH = 1_700_000_040
export const S = (m: number) => EPOCH + 60 * m
export const ts = (n: number) => EPOCH + 1 + 2 * (n - 1000)
export const blockAt = (t: number) => 1000 + Math.floor((t - EPOCH - 1) / 2)
export const minuteOfBlock = (n: number) => Math.floor((ts(n) - EPOCH) / 60)
// WETH USD by minute.
export const PATH = [2000, 2000, 2000, 2000, 2000, 2000, 2010, 2100, 1900, 1890, 1950, 1960, 1970, 1980, 1990]
export const F_N = 1332
export const weth = (n: number) =>
  n === F_N ? 1990n : BigInt(PATH[Math.max(0, Math.min(PATH.length - 1, minuteOfBlock(n)))])

export const WETH = '0x4200000000000000000000000000000000000006'
export const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
export const ORACLE = '0x000000000000000000000000000000000000c0c0'
export const MARKET = '0x' + '11'.repeat(32)
export const ZERO = '0x0000000000000000000000000000000000000000'
export const LIDO = {
  provider: '0x00000000000000000000000000000000000001a1',
  pool: '0x00000000000000000000000000000000000001b1',
  oracle: '0x00000000000000000000000000000000000001c1',
  dataProvider: '0x00000000000000000000000000000000000001d1',
}
export const A = '0x00000000000000000000000000000000000000aa'
export const B = '0x00000000000000000000000000000000000000bb'
export const C = '0x00000000000000000000000000000000000000cc'
export const D = '0x00000000000000000000000000000000000000dd'
export const F = '0x00000000000000000000000000000000000000ff'
export const E18 = 10n ** 18n
export const CORE = CHAIN_CONFIG.base.aavePool

export const reserves = (): FakeReserve[] => [
  { address: WETH, symbol: 'WETH', decimals: 18, id: 0, ltv: 8000, lt: 8300, price: (n) => weth(n) * 10n ** 8n },
  { address: USDC, symbol: 'USDC', decimals: 6, id: 1, ltv: 7500, lt: 7800, price: () => 10n ** 8n },
]

export function chainSpec(): FakeChainSpec {
  return {
    chain: 'base',
    ts,
    head: 1000 + 30 * 40,
    reserves: reserves(),
    tokens: {},
    users: [
      { address: A, eMode: 0, collateral: { [WETH]: 10n * E18 }, debt: { [USDC]: 17_000_000000n } },
      { address: B, eMode: 0, collateral: { [WETH]: 10n * E18 }, debt: { [USDC]: 15_000_000000n } },
      { address: D, eMode: 0, collateral: { [WETH]: 10n * E18 }, debt: { [USDC]: 17_200_000000n } },
      { address: F, eMode: 0, collateral: { [WETH]: 10n * E18 }, debt: { [USDC]: 16_500_000000n } },
    ],
    extraAave: [
      {
        ...LIDO,
        marketId: 'Fake Lido Market',
        reserves: reserves(),
        users: [{ address: A, eMode: 0, collateral: { [WETH]: 10n * E18 }, debt: { [USDC]: 17_000_000000n } }],
      },
    ],
    markets: [
      {
        id: MARKET,
        loanToken: USDC,
        collateralToken: WETH,
        oracle: ORACLE,
        irm: ZERO,
        lltv: 86n * 10n ** 16n,
        totalBorrowAssets: 174_000_000000n,
        totalBorrowShares: 174_000_000000n * 1_000_000n,
        lastUpdate: BigInt(S(4)),
        price: (n) => weth(n) * 10n ** 24n,
        rate: 0n,
      },
    ],
    morphoPositions: [
      { marketId: MARKET, borrower: C, borrowShares: 17_400_000000n * 1_000_000n, collateral: 10n * E18 },
    ],
    logs: [
      aaveLog('base', { block: 1165, logIndex: 3, collateral: WETH, debt: USDC, user: A, debtToCover: 8_500_000000n, liquidated: 44n * 10n ** 17n }),
      aaveLog('base', { block: 1166, logIndex: 1, pool: LIDO.pool, collateral: WETH, debt: USDC, user: A, debtToCover: 8_500_000000n, liquidated: 44n * 10n ** 17n }),
      morphoLog('base', { block: 1170, logIndex: 1, marketId: MARKET, borrower: C, repaidAssets: 500_000000n, seizedAssets: 26n * 10n ** 16n }),
      aaveLog('base', { block: 1185, logIndex: 2, collateral: WETH, debt: USDC, user: B, debtToCover: 7_500_000000n, liquidated: 39n * 10n ** 17n }),
      aaveLog('base', { block: 1186, logIndex: 4, collateral: WETH, debt: USDC, user: D, debtToCover: 8_600_000000n, liquidated: 45n * 10n ** 17n }),
      aaveLog('base', { block: 1277, logIndex: 1, collateral: WETH, debt: USDC, user: A, debtToCover: 1_000_000000n, liquidated: 5n * 10n ** 17n }),
      aaveLog('base', { block: F_N, logIndex: 7, collateral: WETH, debt: USDC, user: F, debtToCover: 8_250_000000n, liquidated: 43n * 10n ** 17n }),
    ],
  }
}

export const OPTS: EngineOptions = {
  mode: 'historical',
  chains: ['base'],
  epochTs: EPOCH,
  startMinute: 3,
  endMinute: 15,
  reconcileEveryMinutes: 0,
  readConcurrency: 4,
}

export function engine(fake: FakeChain, sink: StreamSink, opts: Partial<EngineOptions> = {}, clock?: SimClock, head?: HeadFn) {
  return new LiveEngine(
    {
      rpc: fake,
      clock: clock ?? new SimClock(S(opts.startMinute ?? 3) * 1000),
      sink,
      head: head ?? clockHead(),
      backoff: async () => {},
    },
    { ...OPTS, ...opts },
  )
}

export async function runAll(fake = new FakeChain(chainSpec()), opts: Partial<EngineOptions> = {}) {
  const sink = new MemorySink()
  const e = engine(fake, sink, opts)
  await e.init()
  await e.run()
  return { sink, e, fake }
}

export const strip = (r: LiveRecord) => {
  const { seq, backfilled, late, eventTs, ...rest } = r
  void seq
  void backfilled
  void late
  void eventTs
  return rest
}
export const pidOf = (r: LiveRecord) => (r.kind === 'tick' ? null : r.pid)
export const pidA = `aave-v3:base:${CORE}:${A}`
export const pidAL = `aave-v3:base:${LIDO.pool}:${A}`
export const pidB = `aave-v3:base:${CORE}:${B}`
export const pidC = `morpho-blue:base:${MARKET}:${C}`
export const pidD = `aave-v3:base:${CORE}:${D}`
export const pidF = `aave-v3:base:${CORE}:${F}`


/** The whole scenario into `sink` (default a MemorySink). */
export async function runScenario<T extends StreamSink = MemorySink>(
  x: { sink?: T; fake?: FakeChain; opts?: Partial<EngineOptions> } = {},
) {
  const sink = (x.sink ?? new MemorySink()) as T
  const fake = x.fake ?? new FakeChain(chainSpec())
  const e = engine(fake, sink, x.opts ?? {})
  await e.init()
  await e.run()
  return { sink, e, fake }
}
