/**
 * A scripted chain for the live engine's tests: block headers, eth_getLogs over scripted
 * liquidation logs, and eth_call / Multicall3 answered by decoding the real calldata the engine
 * sends (the ABIs of scripts/oct10-coverage/abi.ts) and encoding the answers. It serves an Aave
 * PoolAddressesProviderRegistry with the Core market (CHAIN_CONFIG's addresses) and any extra
 * markets, Morpho Blue, and three backend groups ('g1', 'g2', 'g3') so the two-backend logs
 * check and the reconciliation can be exercised; `logsFault` / `priceFault` make groups misbehave
 * and `headLag` makes a group's node trail the head (its blockNumber is lower and a logs range
 * past its own head comes back SHORT, without an error — what dRPC and arb1 do). eth_getLogs is
 * answered by topic over every emitter, so `forks` (contracts emitting the same LiquidationCall
 * signature, with their own ADDRESSES_PROVIDER() or none) can be scripted.
 */
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  keccak256,
  parseAbi,
  toHex as vToHex,
  type Abi,
  type Hex,
} from 'viem'
import {
  dataProviderAbi,
  erc20Abi,
  irmAbi,
  morphoAbi,
  morphoOracleAbi,
  multicallAbi,
  MULTICALL3,
  oracleAbi,
  poolAbi,
  providerAbi,
} from '../../scripts/oct10-coverage/abi'
import { NoBackendError, type CallOpts, type ChainKey, type RpcAnswer } from '../../scripts/oct10-coverage/rpc'
import {
  AAVE_LIQUIDATION_CALL_TOPIC,
  CHAIN_CONFIG,
  MORPHO_LIQUIDATE_TOPIC,
  type LiveRpc,
} from '../../lib/wavefront/live'

const lc = (s: string) => s.toLowerCase()
const pad = (a: string) => '0x' + a.slice(2).toLowerCase().padStart(64, '0')
const RAY = 10n ** 27n

export interface FakeReserve {
  address: string
  symbol: string
  decimals: number
  id: number
  ltv: number
  lt: number
  /** Liquidation bonus and protocol fee, bps (default 10500 / 1000). */
  bonus?: number
  protocolFee?: number
  /** Raw AaveOracle price (1e8) at a block. */
  price: (block: number) => bigint
}

export interface FakeAaveUser {
  address: string
  eMode: number
  /** aToken balances (raw) by asset; collateral flag on for these. */
  collateral: Record<string, bigint>
  /** variable debt (raw) by asset. */
  debt: Record<string, bigint>
  /** Recorded reads, overriding what the fields above would give. */
  userConfig?: bigint
  accountData?: bigint[]
  stableDebt?: Record<string, bigint>
  usage?: Record<string, boolean>
}

export interface FakeMorphoMarket {
  id: string
  loanToken: string
  collateralToken: string
  oracle: string
  irm: string
  lltv: bigint
  totalBorrowAssets: bigint
  totalBorrowShares: bigint
  lastUpdate: bigint
  /** price() at a block (1e36-scaled). */
  price: (block: number) => bigint
  rate: bigint
}

export interface FakeMorphoPosition {
  marketId: string
  borrower: string
  borrowShares: bigint
  collateral: bigint
}

export interface FakeLog {
  block: number
  logIndex: number
  tx: string
  address: string
  topics: string[]
  data: string
}

/** An Aave market besides Core (its own provider, pool, oracle, reserves and users). */
export interface FakeAaveMarket {
  provider: string
  pool: string
  oracle: string
  dataProvider: string
  marketId: string
  reserves: FakeReserve[]
  users: FakeAaveUser[]
  /** Listed by the registry only from this block on (a market added mid-stream). */
  registryFrom?: number
}

/** A non-registry contract emitting LiquidationCall: a fork (own provider) or no provider. */
export interface FakeFork {
  pool: string
  /** Its ADDRESSES_PROVIDER(); null = the call reverts. */
  provider: string | null
}

export interface FakeChainSpec {
  chain: ChainKey
  /** Block n's timestamp. */
  ts: (n: number) => number
  head: number
  reserves: FakeReserve[]
  tokens: Record<string, { symbol: string; decimals: number }>
  users: FakeAaveUser[]
  markets: FakeMorphoMarket[]
  morphoPositions: FakeMorphoPosition[]
  logs: FakeLog[]
  /** E-mode categories: collateral LT and the reserve-id bitmap. */
  emode?: { id: number; lt: number; bitmap: bigint }[]
  extraAave?: FakeAaveMarket[]
  /** Markets NOT in the registry (an allow-list candidate, e.g. Horizon), answering like one. */
  outsideRegistry?: FakeAaveMarket[]
  forks?: FakeFork[]
}

export const blockHash = (chain: string, n: number) => keccak256(vToHex(`${chain}:${n}`))

export function aaveLog(
  chain: ChainKey,
  x: {
    block: number
    logIndex: number
    tx?: string
    pool?: string
    collateral: string
    debt: string
    user: string
    debtToCover: bigint
    liquidated: bigint
  },
): FakeLog {
  return {
    block: x.block,
    logIndex: x.logIndex,
    tx: x.tx ?? keccak256(vToHex(`tx:${chain}:${x.block}:${x.logIndex}`)),
    address: x.pool ?? CHAIN_CONFIG[chain].aavePool,
    topics: [AAVE_LIQUIDATION_CALL_TOPIC, pad(x.collateral), pad(x.debt), pad(x.user)],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'bool' }],
      [x.debtToCover, x.liquidated, '0x000000000000000000000000000000000000dEaD', false],
    ),
  }
}

export function morphoLog(
  chain: ChainKey,
  x: {
    block: number
    logIndex: number
    tx?: string
    marketId: string
    borrower: string
    repaidAssets: bigint
    seizedAssets: bigint
    badDebtAssets?: bigint
  },
): FakeLog {
  return {
    block: x.block,
    logIndex: x.logIndex,
    tx: x.tx ?? keccak256(vToHex(`tx:${chain}:${x.block}:${x.logIndex}`)),
    address: CHAIN_CONFIG[chain].morpho,
    topics: [
      MORPHO_LIQUIDATE_TOPIC,
      x.marketId,
      pad('0x000000000000000000000000000000000000beef'),
      pad(x.borrower),
    ],
    data: encodeAbiParameters(
      Array(5).fill({ type: 'uint256' }),
      [x.repaidAssets, x.repaidAssets, x.seizedAssets, x.badDebtAssets ?? 0n, 0n],
    ),
  }
}

const extraAbi = parseAbi([
  'function getAddressesProvidersList() view returns (address[])',
  'function getMarketId() view returns (string)',
  'function scaledBalanceOf(address user) view returns (uint256)',
  'function ADDRESSES_PROVIDER() view returns (address)',
])

const ABIS: Abi[] = [
  providerAbi,
  poolAbi,
  dataProviderAbi,
  oracleAbi,
  erc20Abi,
  morphoAbi,
  morphoOracleAbi,
  irmAbi,
  multicallAbi,
  extraAbi,
]

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b

export const CORE_DATA_PROVIDER = '0x00000000000000000000000000000000000000d1'

export class FakeChain implements LiveRpc {
  readonly calls: { method: string; group: string; params: unknown[] }[] = []
  /** Logs these groups must not return (simulated false empty / short answer). */
  logsFault: { groups: string[]; drop: (l: FakeLog) => boolean } | null = null
  /** Blocks a group's node trails the head by (blockNumber, and logs past its own head). */
  headLag: Record<string, number> = {}
  /** Groups that answer these price reads (block, asset or Morpho oracle) as 0. */
  priceFault: { groups: string[]; bad: (block: number, key: string) => boolean } | null = null
  /** Highest toBlock any eth_getLogs asked for. */
  maxLogsTo = 0
  /** Backend groups this fake serves (each with one host, `<group>.host`). */
  groupList = ['g1', 'g2', 'g3']
  /** Every eth_getLogs range asked, with the head at that moment. */
  readonly logRanges: { from: number; to: number; head: number; group: string }[] = []
  readonly dataProvider = CORE_DATA_PROVIDER

  constructor(readonly spec: FakeChainSpec) {}

  get cfg() {
    return CHAIN_CONFIG[this.spec.chain]
  }

  /** Every market that answers calls: the registry's and the ones outside it. */
  allMarkets(): FakeAaveMarket[] {
    const norm = (m: FakeAaveMarket) => ({
      ...m,
      provider: lc(m.provider),
      pool: lc(m.pool),
      oracle: lc(m.oracle),
      dataProvider: lc(m.dataProvider),
    })
    return [...this.aaveMarkets(), ...(this.spec.outsideRegistry ?? []).map(norm)]
  }

  /** Core + extra Aave markets (the registry's list). */
  aaveMarkets(): FakeAaveMarket[] {
    const S = this.spec
    return [
      {
        provider: lc(this.cfg.aaveProvider),
        pool: this.cfg.aavePool,
        oracle: this.cfg.aaveOracle,
        dataProvider: this.dataProvider,
        marketId: 'Fake Core Market',
        reserves: S.reserves,
        users: S.users,
      },
      ...(S.extraAave ?? []).map((m) => ({
        ...m,
        provider: lc(m.provider),
        pool: lc(m.pool),
        oracle: lc(m.oracle),
        dataProvider: lc(m.dataProvider),
      })),
    ]
  }

  groups(): string[] {
    return [...this.groupList]
  }

  private pickGroup(opts?: CallOpts): string {
    const ex = new Set(opts?.excludeGroups ?? [])
    const exH = new Set(opts?.excludeHosts ?? [])
    const g = this.groupList.find(
      (x) => !ex.has(x) && !exH.has(`${x}.host`) && (!opts?.onlyGroup || x === opts.onlyGroup),
    )
    if (!g) throw new NoBackendError('no eligible endpoint')
    return g
  }

  async request(chain: ChainKey, method: string, params: unknown[], opts?: CallOpts): Promise<RpcAnswer> {
    if (chain !== this.spec.chain) throw new Error(`fake chain ${this.spec.chain} asked for ${chain}`)
    const group = this.pickGroup(opts)
    this.calls.push({ method, group, params })
    const ans = (result: unknown): RpcAnswer => ({ result, host: `${group}.host`, group })
    switch (method) {
      case 'eth_blockNumber':
        return ans('0x' + (this.spec.head - (this.headLag[group] ?? 0)).toString(16))
      case 'eth_getBlockByNumber': {
        const n = Number(BigInt(params[0] as string))
        if (n > this.spec.head) throw new Error(`block ${n} beyond head ${this.spec.head}`)
        return ans({
          number: '0x' + n.toString(16),
          hash: blockHash(chain, n),
          timestamp: '0x' + this.spec.ts(n).toString(16),
        })
      }
      case 'eth_getCode':
        return ans('0x6080')
      case 'eth_getLogs': {
        const f = params[0] as { address?: string[]; topics: string[][]; fromBlock: string; toBlock: string }
        const from = Number(BigInt(f.fromBlock))
        const to = Number(BigInt(f.toBlock))
        if (to > this.spec.head) throw new Error(`logs beyond head`)
        this.maxLogsTo = Math.max(this.maxLogsTo, to)
        this.logRanges.push({ from, to, head: this.spec.head, group })
        // A node behind the head answers up to its own head: a short list, no error.
        const nodeHead = this.spec.head - (this.headLag[group] ?? 0)
        const addrs = f.address ? new Set(f.address.map(lc)) : null
        const topics = new Set(f.topics[0].map(lc))
        const out = this.spec.logs
          .filter(
            (l) =>
              l.block >= from &&
              l.block <= Math.min(to, nodeHead) &&
              (!addrs || addrs.has(lc(l.address))) &&
              topics.has(lc(l.topics[0])),
          )
          .filter((l) => !(this.logsFault && this.logsFault.groups.includes(group) && this.logsFault.drop(l)))
          .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
          .map((l) => ({
            address: l.address,
            topics: l.topics,
            data: l.data,
            blockNumber: '0x' + l.block.toString(16),
            blockHash: blockHash(chain, l.block),
            transactionHash: l.tx,
            logIndex: '0x' + l.logIndex.toString(16),
            removed: false,
          }))
        return ans(out)
      }
      case 'eth_call': {
        const [{ to, data }, blockHex] = params as [{ to: string; data: Hex }, string]
        const block = Number(BigInt(blockHex))
        const r = this.call(lc(to), data, block, group)
        if (r === null) return { revert: { message: 'execution reverted' }, host: `${group}.host`, group }
        return ans(r)
      }
    }
    throw new Error(`fake: ${method} not scripted`)
  }

  private decode(data: Hex): { abi: Abi; fn: string; args: readonly unknown[] } {
    for (const abi of ABIS) {
      try {
        const d = decodeFunctionData({ abi, data })
        return { abi, fn: d.functionName, args: (d.args ?? []) as readonly unknown[] }
      } catch {
        /* next abi */
      }
    }
    throw new Error(`fake: cannot decode ${data.slice(0, 10)}`)
  }

  /** Encoded return data, or null for a revert. */
  call(to: string, data: Hex, block: number, group = 'g1'): Hex | null {
    const { abi, fn, args } = this.decode(data)
    const enc = (result: unknown) =>
      encodeFunctionResult({ abi, functionName: fn, result } as never) as Hex
    if (to === lc(MULTICALL3) && fn === 'aggregate3') {
      const calls = args[0] as { target: string; callData: Hex }[]
      const rows = calls.map((c) => {
        const r = this.call(lc(c.target), c.callData, block, group)
        return r === null ? { success: false, returnData: '0x' as Hex } : { success: true, returnData: r }
      })
      return enc(rows)
    }
    const v = this.answer(to, fn, args, block, group)
    return v === undefined ? null : enc(v)
  }

  private config(r: FakeReserve) {
    return (
      BigInt(r.ltv) |
      (BigInt(r.lt) << 16n) |
      (BigInt(r.bonus ?? 10_500) << 32n) |
      (BigInt(r.decimals) << 48n) |
      (BigInt(r.protocolFee ?? 1000) << 152n)
    )
  }

  private userAccount(m: FakeAaveMarket, u: FakeAaveUser, block: number) {
    let coll = 0n
    let debt = 0n
    let s = 0n
    for (const r of m.reserves) {
      const unit = 10n ** BigInt(r.decimals)
      const p = r.price(block)
      const a = u.collateral[lc(r.address)] ?? 0n
      if (a > 0n && r.lt > 0) {
        const bal = (a * p) / unit
        coll += bal
        s += bal * BigInt(r.lt)
      }
      const d = u.debt[lc(r.address)] ?? 0n
      if (d > 0n) debt += ceilDiv(d * p, unit)
    }
    const hf = debt === 0n ? 2n ** 256n - 1n : (s * 10n ** 18n) / (debt * 10000n)
    return [coll, debt, 0n, coll ? s / coll : 0n, 0n, hf]
  }

  private faulty(group: string, block: number, key: string) {
    return !!this.priceFault && this.priceFault.groups.includes(group) && this.priceFault.bad(block, key)
  }

  private price(m: FakeAaveMarket, asset: string, block: number, group: string): bigint {
    const r = m.reserves.find((x) => lc(x.address) === lc(asset))
    if (!r || this.faulty(group, block, lc(asset))) return 0n
    return r.price(block)
  }

  private answer(to: string, fn: string, args: readonly unknown[], block: number, group: string): unknown {
    const S = this.spec
    const cfg = this.cfg
    const markets = this.allMarkets()
    if (to === cfg.aaveRegistry && fn === 'getAddressesProvidersList')
      return this.aaveMarkets()
        .filter((m) => (m.registryFrom ?? 0) <= block)
        .map((m) => m.provider)
    const fork = S.forks?.find((x) => lc(x.pool) === to)
    if (fork && fn === 'ADDRESSES_PROVIDER') return fork.provider ?? undefined
    const byProvider = markets.find((m) => m.provider === to)
    if (byProvider) {
      if (fn === 'getPool') return byProvider.pool
      if (fn === 'getPriceOracle') return byProvider.oracle
      if (fn === 'getPoolDataProvider') return byProvider.dataProvider
      if (fn === 'getMarketId') return byProvider.marketId
    }
    const byPool = markets.find((m) => m.pool === to)
    if (byPool) {
      const reserve = (a: string) => byPool.reserves.find((r) => lc(r.address) === lc(a))
      if (fn === 'ADDRESSES_PROVIDER') return byPool.provider
      if (fn === 'POOL_REVISION') return 9n
      if (fn === 'getReservesList') return byPool.reserves.map((r) => r.address)
      if (fn === 'getReserveData') {
        const r = reserve(args[0] as string)!
        return {
          configuration: this.config(r),
          liquidityIndex: RAY,
          currentLiquidityRate: 0n,
          variableBorrowIndex: RAY,
          currentVariableBorrowRate: 0n,
          currentStableBorrowRate: 0n,
          lastUpdateTimestamp: S.ts(1000),
          id: r.id,
          aTokenAddress: r.address,
          stableDebtTokenAddress: r.address,
          variableDebtTokenAddress: r.address,
          interestRateStrategyAddress: r.address,
          accruedToTreasury: 0n,
          unbacked: 0n,
          isolationModeTotalDebt: 0n,
        }
      }
      if (fn === 'getConfiguration') return { data: this.config(reserve(args[0] as string)!) }
      if (fn === 'getEModeCategoryLabel')
        return S.emode?.some((c) => c.id === Number(args[0])) ? `cat ${args[0]}` : ''
      if (fn === 'getEModeCategoryCollateralConfig') {
        const c = S.emode!.find((x) => x.id === Number(args[0]))!
        return { ltv: c.lt - 100, liquidationThreshold: c.lt, liquidationBonus: 10_100 }
      }
      if (fn === 'getEModeCategoryCollateralBitmap')
        return S.emode!.find((x) => x.id === Number(args[0]))!.bitmap
      const u = byPool.users.find((x) => lc(x.address) === lc(args[0] as string))
      if (fn === 'getUserEMode') return BigInt(u?.eMode ?? 0)
      if (fn === 'getUserConfiguration') {
        if (u?.userConfig !== undefined) return { data: u.userConfig }
        let bits = 0n
        for (const r of byPool.reserves) {
          if ((u?.collateral[lc(r.address)] ?? 0n) > 0n) bits |= 1n << (2n * BigInt(r.id) + 1n)
          if ((u?.debt[lc(r.address)] ?? 0n) > 0n) bits |= 1n << (2n * BigInt(r.id))
        }
        return { data: bits }
      }
      if (fn === 'getUserAccountData')
        return u?.accountData ?? (u ? this.userAccount(byPool, u, block) : [0n, 0n, 0n, 0n, 0n, 0n])
    }
    const byDp = markets.find((m) => m.dataProvider === to)
    if (byDp && fn === 'getUserReserveData') {
      const u = byDp.users.find((x) => lc(x.address) === lc(args[1] as string))
      const a = lc(args[0] as string)
      return [
        u?.collateral[a] ?? 0n,
        u?.stableDebt?.[a] ?? 0n,
        u?.debt[a] ?? 0n,
        0n,
        u?.debt[a] ?? 0n,
        0n,
        0n,
        0,
        u?.usage?.[a] ?? (u?.collateral[a] ?? 0n) > 0n,
      ]
    }
    const byOracle = markets.find((m) => m.oracle === to)
    if (byOracle) {
      if (fn === 'BASE_CURRENCY_UNIT') return 100000000n
      if (fn === 'getAssetsPrices')
        return (args[0] as string[]).map((a) => this.price(byOracle, a, block, group))
      if (fn === 'getAssetPrice') return this.price(byOracle, args[0] as string, block, group)
    }
    // aToken scaledBalanceOf (the fake's aToken address is the reserve): index 1, so = balance.
    if (fn === 'scaledBalanceOf') {
      for (const m of markets) {
        if (!m.reserves.some((r) => lc(r.address) === to)) continue
        const u = m.users.find((x) => lc(x.address) === lc(args[0] as string))
        return u?.collateral[to] ?? 0n
      }
    }
    const reserveTok = markets.flatMap((m) => m.reserves).find((r) => lc(r.address) === to)
    const tok = S.tokens[to] ?? (reserveTok && { symbol: reserveTok.symbol, decimals: reserveTok.decimals })
    if (tok && fn === 'symbol') return tok.symbol
    if (tok && fn === 'decimals') return tok.decimals
    if (to === lc(cfg.morpho)) {
      const m = S.markets.find((x) => lc(x.id) === lc(args[0] as string))!
      if (fn === 'idToMarketParams') return [m.loanToken, m.collateralToken, m.oracle, m.irm, m.lltv]
      if (fn === 'market') return [0n, 0n, m.totalBorrowAssets, m.totalBorrowShares, m.lastUpdate, 0n]
      if (fn === 'position') {
        const p = S.morphoPositions.find(
          (x) => lc(x.marketId) === lc(m.id) && lc(x.borrower) === lc(args[1] as string),
        )
        return [0n, p?.borrowShares ?? 0n, p?.collateral ?? 0n]
      }
    }
    const om = S.markets.find((x) => lc(x.oracle) === to)
    if (om && fn === 'price') return this.faulty(group, block, to) ? 0n : om.price(block)
    const im = S.markets.find((x) => lc(x.irm) === to)
    if (im && fn === 'borrowRateView') return im.rate
    return undefined
  }
}
