/**
 * Aave V3 reads for the live engine — the Oct 10 pull's event re-read
 * (scripts/oct10-coverage/aaveEvents.ts), one liquidation at a time, for EVERY Aave V3 pool of a
 * chain (resolved from the PoolAddressesProviderRegistry — `readAaveMarkets`):
 *
 *   at N-1  Pool.getUserAccountData, getUserEMode, getUserConfiguration, and
 *           PoolDataProvider.getUserReserveData for EVERY reserve (one Multicall3);
 *   at N-1 and N  AaveOracle.getAssetsPrices(reserves), Pool.getConfiguration for every
 *           reserve, every e-mode category's collateral config and bitmap (one Multicall3 per
 *           block, shared by every liquidation in that block).
 *
 * The health factor is recomputed with the pull's own `computeHf` (GenericLogic with the v3.5
 * rounding; it reproduced all 3,111 Oct 10 health factors to the wei) and must equal
 * getUserAccountData's at N-1 — a mismatch is re-read once on another backend and counted. The
 * record built here has exactly the shape the pull wrote (aave-events.jsonl.gz), so the census's
 * spec builder (lib/wavefront/aave.ts) takes it unchanged.
 *
 * LOCATING AT N-1 PRICES (`locateAtNm1`). Prices read at the END of block N hide a breach when an
 * oracle update lands later in block N than the liquidation (Oct 10: e.g. Optimism block
 * 142266057 — liquidations at logs 217/357, the OP feed update at log 464). When the position is
 * not liquidatable at N prices, it is re-tested at the N-1 prices with every balance accrued to
 * ts(N) — the state the liquidation itself saw — using Aave's own index math (aave-v3-origin
 * v3.5.0, the Oct 10 pools' revision 9):
 *   normalizedIncome(t) = rayMul(RAY + rate·Δt / SECONDS_PER_YEAR, liquidityIndex)
 *                                          (MathUtils.sol:23-34, ReserveLogic.sol:39-54)
 *   normalizedDebt(t)   = rayMul(RAY + x + rayMul(x, x/2 + rayMul(x, x/6)), variableBorrowIndex),
 *                         x = rate·Δt / SECONDS_PER_YEAR      (MathUtils.sol:79-84, ReserveLogic.sol:63-78)
 *   aToken balance      = rayMulFloor(scaledBalance, normalizedIncome)   (TokenMath.sol:66-71)
 *   debt balance        = rayMulCeil(scaledDebt, normalizedDebt)         (TokenMath.sol:108-113)
 * (checked on every use: accrued to ts(N-1) the same math must give the balances read at N-1).
 *
 * THE PROTOCOL FEE (`protocolFee`). LiquidationCall's liquidatedCollateralAmount is the
 * LIQUIDATOR's share; the collateral taken from the borrower also includes the liquidation
 * protocol fee sent to the treasury. aave-v3-origin v3.5.0 LiquidationLogic.sol:
 *   :224-237  liquidationBonus = the e-mode category's when the collateral is in the borrower's
 *             category bitmap, else the reserve's (config bits 32-47)
 *   :644-653  bonusCollateral = collateralAmount - collateralAmount.percentDiv(liquidationBonus)
 *             fee = bonusCollateral.percentMul(liquidationProtocolFee)   (config bits 152-167)
 *             collateralAmount -= fee
 *   :422-430  emit LiquidationCall(..., actualCollateralToLiquidate = collateralAmount, ...)
 * so the event amount L = X - fee(X); X is recovered exactly by searching the integers around
 * L / (1 - (1 - 1/bonus)·feePct). From revision 11 (v3.7.0, :615-622) the same lines round with
 * percentDivFloor / percentMulCeil; the pool's POOL_REVISION picks the rounding.
 */
import { parseAbi } from 'viem'
import {
  dataProviderAbi,
  erc20Abi,
  oracleAbi,
  poolAbi,
  providerAbi,
  revertReason,
  type SubCall,
  type SubResult,
} from '../../../scripts/oct10-coverage/abi'
import { computeHf } from '../../../scripts/oct10-coverage/aaveEvents'
import type { AaveSetup } from '../../../scripts/oct10-coverage/aaveOracle'
import type { ChainKey } from '../../../scripts/oct10-coverage/rpc'
import type { AaveEventRecord, AaveReserveRead } from '../aave'
import { multicall } from './calls'
import type { AaveLiquidation } from './codec'
import type { ChainConfig } from './config'
import type { LiveRpc } from './rpc'

const lc = (s: string) => s.toLowerCase()
const WAD = 10n ** 18n
const RAY = 10n ** 27n
const HALF_RAY = RAY / 2n
const SECONDS_PER_YEAR = 365n * 24n * 3600n

const registryAbi = parseAbi(['function getAddressesProvidersList() view returns (address[])'])
const marketIdAbi = parseAbi(['function getMarketId() view returns (string)'])
const scaledAbi = parseAbi(['function scaledBalanceOf(address user) view returns (uint256)'])
const poolProviderAbi = parseAbi(['function ADDRESSES_PROVIDER() view returns (address)'])

export interface AaveMarket {
  provider: string
  pool: string
  oracle: string
  dataProvider: string
  marketId: string
}

/**
 * Every Aave V3 market of a chain from its PoolAddressesProviderRegistry, at `block`. The Core
 * market must be among them with the pool and oracle in CHAIN_CONFIG (a moved pool is a stop).
 */
export async function readAaveMarkets(
  rpc: LiveRpc,
  cfg: ChainConfig,
  block: number,
): Promise<AaveMarket[]> {
  const [list] = await multicall(
    rpc,
    cfg.chain,
    [{ target: cfg.aaveRegistry, abi: registryAbi, fn: 'getAddressesProvidersList' }],
    block,
  )
  if (!list.ok) throw new Error(`${cfg.chain}: Aave registry read failed at ${block}`)
  const providers = (list.value as string[])
    .map(lc)
    .filter((p) => p !== '0x0000000000000000000000000000000000000000')
  const r = await multicall(
    rpc,
    cfg.chain,
    providers.flatMap((p) => [
      { target: p, abi: providerAbi, fn: 'getPool' },
      { target: p, abi: providerAbi, fn: 'getPriceOracle' },
      { target: p, abi: providerAbi, fn: 'getPoolDataProvider' },
      { target: p, abi: marketIdAbi, fn: 'getMarketId' },
    ]),
    block,
  )
  const markets: AaveMarket[] = []
  providers.forEach((provider, k) => {
    const [pool, oracle, dp, id] = r.slice(4 * k, 4 * k + 4)
    if (!pool.ok || !oracle.ok || !dp.ok) return
    const p = lc(String(pool.value))
    if (p === '0x0000000000000000000000000000000000000000') return
    markets.push({
      provider,
      pool: p,
      oracle: lc(String(oracle.value)),
      dataProvider: lc(String(dp.value)),
      marketId: id.ok ? String(id.value) : '',
    })
  })
  const core = markets.find((m) => m.provider === lc(cfg.aaveProvider))
  if (!core) throw new Error(`${cfg.chain}: the Core provider ${cfg.aaveProvider} is not in the registry`)
  if (core.pool !== cfg.aavePool) throw new Error(`${cfg.chain}: Core pool ${core.pool} != ${cfg.aavePool}`)
  if (core.oracle !== cfg.aaveOracle)
    throw new Error(`${cfg.chain}: Core oracle ${core.oracle} != ${cfg.aaveOracle}`)
  // Two providers on one pool would make one pool's events ambiguous.
  if (new Set(markets.map((m) => m.pool)).size !== markets.length)
    throw new Error(`${cfg.chain}: two registry markets share a pool`)
  return markets
}

/**
 * An emitter's `ADDRESSES_PROVIDER()` at `block` (lower case), or null when it has none (reverts,
 * no code, an Aave V2 LendingPool — which has getAddressesProvider() instead — or anything else
 * that emits the same LiquidationCall signature). The engine's scope rule: an emitter is an Aave
 * V3 pool iff this returns a provider in the chain's registry (or an allow-listed one).
 */
export async function readAddressesProvider(
  rpc: LiveRpc,
  chain: ChainKey,
  emitter: string,
  block: number,
): Promise<string | null> {
  const [r] = await multicall(
    rpc,
    chain,
    [{ target: emitter, abi: poolProviderAbi, fn: 'ADDRESSES_PROVIDER' }],
    block,
  )
  if (!r.ok) return null
  const v = lc(String(r.value))
  return /^0x[0-9a-f]{40}$/.test(v) && v !== '0x0000000000000000000000000000000000000000' ? v : null
}

/** One market from its PoolAddressesProvider (an allow-listed instance outside the registry). */
export async function readAaveMarketOf(
  rpc: LiveRpc,
  chain: ChainKey,
  provider: string,
  block: number,
): Promise<AaveMarket | null> {
  const p = lc(provider)
  const [pool, oracle, dp, id] = await multicall(
    rpc,
    chain,
    [
      { target: p, abi: providerAbi, fn: 'getPool' },
      { target: p, abi: providerAbi, fn: 'getPriceOracle' },
      { target: p, abi: providerAbi, fn: 'getPoolDataProvider' },
      { target: p, abi: marketIdAbi, fn: 'getMarketId' },
    ],
    block,
  )
  if (!pool.ok || !oracle.ok || !dp.ok) return null
  return {
    provider: p,
    pool: lc(String(pool.value)),
    oracle: lc(String(oracle.value)),
    dataProvider: lc(String(dp.value)),
    marketId: id.ok ? String(id.value) : '',
  }
}

export interface AaveLiveAsset {
  address: string
  symbol: string
  decimals: number
  id: number
}

export interface AaveLiveSetup {
  chain: ChainKey
  pool: string
  oracle: string
  dataProvider: string
  baseUnit: string
  /** Pool.POOL_REVISION — picks the liquidation fee rounding. */
  revision: number
  reserves: string[]
  assets: AaveLiveAsset[]
  emodeIds: number[]
  readAt: number
}

type UserState = Parameters<typeof computeHf>[1] & {
  scaledVariableDebt: bigint[]
}
type BlockState = Parameters<typeof computeHf>[2] & {
  emodeBonus: Map<number, bigint>
}

/** The pull's AaveSetup shape around a live setup, for `computeHf` (it reads assets' id/address). */
function pullSetup(s: AaveLiveSetup): AaveSetup {
  return {
    chain: s.chain,
    pool: s.pool,
    oracle: s.oracle,
    dataProvider: s.dataProvider,
    poolRevision: String(s.revision),
    baseUnit: s.baseUnit,
    baseCurrency: '',
    fallbackOracle: '',
    b0: s.readAt,
    bEnd: s.readAt,
    reserves: s.reserves,
    assets: s.assets.map((a) => ({
      ...a,
      source: '',
      sourceEnd: '',
      configStart: '',
      configEnd: '',
      inListStart: true,
      inListEnd: true,
    })),
    emodeStart: [],
    emodeEnd: [],
    notes: [],
  }
}

const symbolOf = (r: SubResult): string => {
  if (r.ok) return String(r.value)
  if (r.raw && r.raw.length === 66)
    return Buffer.from(r.raw.slice(2), 'hex').toString('utf8').replace(/\0+$/, '')
  return ''
}

/** Resolve one market's pool, oracle and data provider and read its reserves at `block`. */
export async function readAaveSetup(
  rpc: LiveRpc,
  chain: ChainKey,
  market: AaveMarket,
  block: number,
): Promise<AaveLiveSetup> {
  const r = await multicall(
    rpc,
    chain,
    (['getPool', 'getPriceOracle', 'getPoolDataProvider'] as const).map((fn) => ({
      target: market.provider,
      abi: providerAbi,
      fn,
    })),
    block,
  )
  if (!r.every((x) => x.ok)) throw new Error(`${chain}: PoolAddressesProvider read failed at ${block}`)
  const [pool, oracle, dataProvider] = r.map((x) => lc(String(x.value)))
  if (pool !== market.pool) throw new Error(`${chain}: pool ${pool} != expected ${market.pool}`)
  if (oracle !== market.oracle)
    throw new Error(`${chain}: oracle ${oracle} != expected ${market.oracle}`)
  const [list, unit, rev] = await multicall(
    rpc,
    chain,
    [
      { target: pool, abi: poolAbi, fn: 'getReservesList' },
      { target: oracle, abi: oracleAbi, fn: 'BASE_CURRENCY_UNIT' },
      { target: pool, abi: poolAbi, fn: 'POOL_REVISION' },
    ],
    block,
  )
  if (!list.ok || !unit.ok) throw new Error(`${chain}: reserve list read failed at ${block}`)
  const reserves = (list.value as string[]).map(lc)
  const per = await multicall(
    rpc,
    chain,
    reserves.flatMap((a) => [
      { target: a, abi: erc20Abi, fn: 'symbol' },
      { target: a, abi: erc20Abi, fn: 'decimals' },
      { target: pool, abi: poolAbi, fn: 'getReserveData', args: [a] },
    ]),
    block,
  )
  const assets: AaveLiveAsset[] = reserves.map((a, k) => {
    const rd = per[3 * k + 2]
    if (!per[3 * k + 1].ok || !rd.ok) throw new Error(`${chain} reserve ${a}: setup read failed`)
    return {
      address: a,
      symbol: symbolOf(per[3 * k]),
      decimals: Number(per[3 * k + 1].value),
      id: Number((rd.value as { id: number }).id),
    }
  })
  const ids = [...Array(255).keys()].map((i) => i + 1)
  const labels = await multicall(
    rpc,
    chain,
    ids.map((id) => ({ target: pool, abi: poolAbi, fn: 'getEModeCategoryLabel', args: [id] })),
    block,
  )
  const emodeIds = ids.filter((_, k) => labels[k].ok && String(labels[k].value).length > 0)
  return {
    chain,
    pool,
    oracle,
    dataProvider: lc(dataProvider),
    baseUnit: String(unit.value),
    revision: rev.ok ? Number(rev.value) : 0,
    reserves,
    assets,
    emodeIds,
    readAt: block,
  }
}

function blockCalls(s: AaveLiveSetup): SubCall[] {
  return [
    { target: s.oracle, abi: oracleAbi, fn: 'getAssetsPrices', args: [s.reserves] },
    ...s.reserves.map((a) => ({ target: s.pool, abi: poolAbi, fn: 'getConfiguration', args: [a] })),
    ...s.emodeIds.flatMap((id) => [
      { target: s.pool, abi: poolAbi, fn: 'getEModeCategoryCollateralConfig', args: [id] },
      { target: s.pool, abi: poolAbi, fn: 'getEModeCategoryCollateralBitmap', args: [id] },
    ]),
  ]
}

function userCalls(s: AaveLiveSetup, user: string): SubCall[] {
  return [
    { target: s.pool, abi: poolAbi, fn: 'getUserAccountData', args: [user] },
    { target: s.pool, abi: poolAbi, fn: 'getUserEMode', args: [user] },
    { target: s.pool, abi: poolAbi, fn: 'getUserConfiguration', args: [user] },
    ...s.reserves.map((a) => ({
      target: s.dataProvider,
      abi: dataProviderAbi,
      fn: 'getUserReserveData',
      args: [a, user],
    })),
  ]
}

const ltOf = (cfg: bigint) => (cfg >> 16n) & 0xffffn
const ltvOf = (cfg: bigint) => cfg & 0xffffn
const bonusOf = (cfg: bigint) => (cfg >> 32n) & 0xffffn
const decimalsOf = (cfg: bigint) => Number((cfg >> 48n) & 0xffn)
const protocolFeeOf = (cfg: bigint) => (cfg >> 152n) & 0xffffn

// ------------------------------------------------------------------ Aave math (v3.5.0)

const rayMul = (a: bigint, b: bigint) => (a * b + HALF_RAY) / RAY
const rayMulFloor = (a: bigint, b: bigint) => (a * b) / RAY
const rayMulCeil = (a: bigint, b: bigint) => (a * b + RAY - 1n) / RAY

/** MathUtils.calculateLinearInterest × liquidityIndex (ReserveLogic.getNormalizedIncome). */
export function normalizedIncome(rate: bigint, last: bigint, index: bigint, t: bigint): bigint {
  if (t === last) return index
  return rayMul(RAY + (rate * (t - last)) / SECONDS_PER_YEAR, index)
}

/** MathUtils.calculateCompoundedInterest × variableBorrowIndex (ReserveLogic.getNormalizedDebt). */
export function normalizedDebt(rate: bigint, last: bigint, index: bigint, t: bigint): bigint {
  if (t === last) return index
  const x = (rate * (t - last)) / SECONDS_PER_YEAR
  return rayMul(RAY + x + rayMul(x, x / 2n + rayMul(x, x / 6n)), index)
}

// ------------------------------------------------------------------ protocol fee

const PCT = 10_000n
const HALF_PCT = 5_000n

/**
 * The liquidation protocol fee (raw collateral units) of a LiquidationCall whose event amount
 * (the liquidator's share) is `liquidated` — see the header for the LiquidationLogic lines.
 */
export function aaveProtocolFee(
  liquidated: bigint,
  bonus: bigint,
  feePct: bigint,
  revision: number,
): bigint {
  if (feePct === 0n || bonus <= PCT || liquidated === 0n) return 0n
  const floorCeil = revision >= 11
  const percentDiv = (v: bigint, p: bigint) =>
    floorCeil ? (v * PCT) / p : (v * PCT + p / 2n) / p
  const percentMul = (v: bigint, p: bigint) =>
    floorCeil ? (v * p + PCT - 1n) / PCT : (v * p + HALF_PCT) / PCT
  const feeOf = (x: bigint) => percentMul(x - percentDiv(x, bonus), feePct)
  // L = X - fee(X) ≈ X·(bonus·PCT - (bonus - PCT)·feePct) / (bonus·PCT): invert in integers,
  // then search the neighbours for the exact X.
  const x0 = (liquidated * bonus * PCT) / (bonus * PCT - (bonus - PCT) * feePct)
  let best: bigint | null = null
  for (let d = -8n; d <= 8n; d++) {
    const x = x0 + d
    if (x < liquidated) continue
    if (x - feeOf(x) === liquidated) {
      best = x
      break
    }
  }
  const x = best ?? x0
  return x - liquidated > 0n ? x - liquidated : 0n
}

// ------------------------------------------------------------------ reader

export interface AaveRead {
  record: AaveEventRecord
  /** getUserAccountData's HF at N-1 equals the recompute (the pull: 3,111 / 3,111). */
  hfExact: boolean
  /** AaveOracle price of any reserve at N (raw, base unit), for the real side. */
  priceN: (asset: string) => bigint | null
  /** Liquidation bonus and protocol fee (bps) that applied to this event's collateral. */
  fee: { bonus: bigint; feePct: bigint; revision: number }
  /** The raw reads, for `locateAtNm1`. */
  raw: { u: UserState; bp: BlockState; bn: BlockState; setup: AaveLiveSetup }
}

export interface AaveReaderStats {
  events: number
  hfExact: number
  hfMismatch: number
  blockStates: number
  userReads: number
  setupRefreshes: number
  locatedAtNm1: number
  accrualCheckFailed: number
}

/** One pool's Aave reader: setup, per-block state cache, per-event re-read. */
export class AaveReader {
  setup: AaveLiveSetup | null = null
  private states = new Map<number, Promise<BlockState>>()
  readonly stats: AaveReaderStats = {
    events: 0,
    hfExact: 0,
    hfMismatch: 0,
    blockStates: 0,
    userReads: 0,
    setupRefreshes: 0,
    locatedAtNm1: 0,
    accrualCheckFailed: 0,
  }

  constructor(
    readonly rpc: LiveRpc,
    readonly cfg: ChainConfig,
    readonly market: AaveMarket,
    /** Block timestamp (the accrual check of `locateAtNm1`). */
    readonly blockTs?: (n: number) => Promise<number>,
  ) {}

  async ensureSetup(block: number, force = false): Promise<AaveLiveSetup> {
    if (!this.setup || force) {
      if (this.setup) this.stats.setupRefreshes++
      this.setup = await readAaveSetup(this.rpc, this.cfg.chain, this.market, block)
      this.states.clear()
    }
    return this.setup
  }

  isReserve(asset: string): boolean {
    return !!this.setup?.reserves.includes(lc(asset))
  }

  private async readBlockState(block: number, opts?: { excludeGroups?: string[] }) {
    const s = this.setup!
    const calls = blockCalls(s)
    this.stats.blockStates++
    const res = await multicall(this.rpc, this.cfg.chain, calls, block, opts)
    const R = s.reserves.length
    let prices: (bigint | null)[]
    let priceErr: (string | null)[] = Array(R).fill(null)
    if (res[0].ok) prices = [...(res[0].value as readonly bigint[])]
    else {
      // One reverting source reverts the batch: read every reserve on its own (the pull's rule).
      const per = await multicall(
        this.rpc,
        this.cfg.chain,
        s.reserves.map((a) => ({ target: s.oracle, abi: oracleAbi, fn: 'getAssetPrice', args: [a] })),
        block,
        opts,
      )
      prices = per.map((r) => (r.ok ? (r.value as bigint) : null))
      priceErr = per.map((r) => (r.ok ? null : revertReason(r.err)))
    }
    const config = s.reserves.map((a, k) => {
      const r = res[1 + k]
      if (!r.ok) throw new Error(`${this.cfg.chain} getConfiguration failed for ${a} at ${block}`)
      return (r.value as { data: bigint }).data
    })
    const emode = new Map<number, { lt: bigint; ltv: bigint; bitmap: bigint }>()
    const emodeBonus = new Map<number, bigint>()
    s.emodeIds.forEach((id, k) => {
      const c = res[1 + R + 2 * k]
      const b = res[1 + R + 2 * k + 1]
      if (!c.ok || !b.ok) throw new Error(`${this.cfg.chain} e-mode ${id} read failed at ${block}`)
      const v = c.value as { ltv: number; liquidationThreshold: number; liquidationBonus: number }
      emode.set(id, {
        lt: BigInt(v.liquidationThreshold),
        ltv: BigInt(v.ltv),
        bitmap: b.value as bigint,
      })
      emodeBonus.set(id, BigInt(v.liquidationBonus))
    })
    return { prices, priceErr, config, emode, emodeBonus } as BlockState
  }

  blockState(block: number): Promise<BlockState> {
    let p = this.states.get(block)
    if (!p) {
      p = this.readBlockState(block)
      p.catch(() => this.states.delete(block))
      this.states.set(block, p)
      // Bounded: a block state is reused by the liquidations of that block, rarely later.
      if (this.states.size > 256) this.states.delete(this.states.keys().next().value as number)
    }
    return p
  }

  private async userState(
    user: string,
    block: number,
    opts?: { excludeGroups?: string[] },
    meta?: { group?: string },
  ): Promise<UserState> {
    const s = this.setup!
    this.stats.userReads++
    const res = await multicall(this.rpc, this.cfg.chain, userCalls(s, user), block, opts, meta)
    for (const [k, r] of res.entries())
      if (!r.ok) throw new Error(`user multicall sub-call ${k} failed: ${revertReason(r.err)}`)
    const a = res[0].value as readonly bigint[]
    const rows = s.reserves.map((_, k) => res[3 + k].value as readonly unknown[])
    return {
      account: {
        totalCollateralBase: a[0],
        totalDebtBase: a[1],
        availableBorrowsBase: a[2],
        currentLiquidationThreshold: a[3],
        ltv: a[4],
        healthFactor: a[5],
      },
      eMode: Number(res[1].value as bigint),
      userConfig: (res[2].value as { data: bigint }).data,
      reserves: rows.map((v) => ({
        aToken: v[0] as bigint,
        stableDebt: v[1] as bigint,
        variableDebt: v[2] as bigint,
        usageAsCollateralEnabled: v[8] as boolean,
      })),
      scaledVariableDebt: rows.map((v) => v[4] as bigint),
    }
  }

  /** Every reserve id the user's configuration flags must be a known reserve. */
  private knowsAllFlags(u: UserState): boolean {
    const ids = new Set(this.setup!.assets.map((a) => BigInt(a.id)))
    for (let id = 0n; id < 128n; id++) {
      if (((u.userConfig >> (2n * id)) & 3n) !== 0n && !ids.has(id)) return false
    }
    return true
  }

  /** The pull's record shape from the reads; `prices` / `balances` let the N-1 basis reuse it. */
  private record(
    ev: AaveLiquidation,
    setup: AaveLiveSetup,
    u: UserState,
    bp: BlockState,
    pricesNm1: (bigint | null)[],
    pricesN: (bigint | null)[],
  ): AaveEventRecord {
    const S = pullSetup(setup)
    const atN = computeHf(S, u, bp, pricesN)
    const liq = atN.missingPrice.length === 0 && atN.healthFactor < WAD
    const em = u.eMode ? bp.emode.get(u.eMode) : undefined
    const position: AaveReserveRead[] = []
    setup.assets.forEach((a, k) => {
      const id = BigInt(a.id)
      const ur = u.reserves[k]
      const flags = (u.userConfig >> (2n * id)) & 3n
      if (!flags && !ur.aToken && !ur.variableDebt && !ur.stableDebt) return
      const cfg = bp.config[k]
      const inEm = !!em && ((em.bitmap >> id) & 1n) === 1n
      position.push({
        asset: a.address,
        symbol: a.symbol,
        decimals: decimalsOf(cfg),
        aTokenBalance: ur.aToken.toString(),
        variableDebt: ur.variableDebt.toString(),
        stableDebt: ur.stableDebt.toString(),
        collateralFlag: (flags & 2n) === 2n,
        ltUsed: Number(inEm && ltOf(cfg) !== 0n ? em!.lt : ltOf(cfg)),
        priceNm1: pricesNm1[k]?.toString() ?? null,
        priceN: pricesN[k]?.toString() ?? null,
        ...{
          id: a.id,
          usageAsCollateralEnabled: ur.usageAsCollateralEnabled,
          borrowingFlag: (flags & 1n) === 1n,
          ltv: Number(ltvOf(cfg)),
          lt: Number(ltOf(cfg)),
        },
      } as AaveReserveRead)
    })
    return {
      chain: ev.chain,
      block_number: ev.block,
      log_index: ev.logIndex,
      tx_hash: ev.tx,
      user: ev.user,
      ts: ev.ts,
      collateral_asset: ev.collateralAsset,
      debt_asset: ev.debtAsset,
      eMode: u.eMode,
      position,
      atN: {
        hf: Number(atN.healthFactor) / 1e18,
        liquidatable: liq,
        healthFactor: atN.healthFactor.toString(),
      },
      hfNm1: Number(u.account.healthFactor) / 1e18,
    }
  }

  /** The pull's per-event record for one LiquidationCall (position at N-1, prices at N-1 and N). */
  async read(ev: AaveLiquidation): Promise<AaveRead> {
    const P = ev.block - 1
    let setup = await this.ensureSetup(P)
    if (!this.isReserve(ev.collateralAsset) || !this.isReserve(ev.debtAsset))
      setup = await this.ensureSetup(P, true)
    const meta: { group?: string } = {}
    let [u, bp, bn] = await Promise.all([
      this.userState(ev.user, P, undefined, meta),
      this.blockState(P),
      this.blockState(ev.block),
    ])
    if (!this.knowsAllFlags(u) || (u.eMode && !bp.emode.has(u.eMode))) {
      setup = await this.ensureSetup(P, true)
      ;[u, bp, bn] = await Promise.all([
        this.userState(ev.user, P, undefined, meta),
        this.blockState(P),
        this.blockState(ev.block),
      ])
    }
    const S = pullSetup(setup)
    let prev = computeHf(S, u, bp, bp.prices)
    if (prev.healthFactor !== u.account.healthFactor) {
      // Re-read the position and the N-1 state on another backend once before believing it.
      const other = { excludeGroups: meta.group ? [meta.group] : [] }
      u = await this.userState(ev.user, P, other)
      bp = await this.readBlockState(P, other)
      prev = computeHf(S, u, bp, bp.prices)
    }
    const hfExact = prev.healthFactor === u.account.healthFactor
    this.stats.events++
    if (hfExact) this.stats.hfExact++
    else this.stats.hfMismatch++
    const record = this.record(ev, setup, u, bp, bp.prices, bn.prices)
    const reserves = setup.reserves
    const k = reserves.indexOf(lc(ev.collateralAsset))
    const cfg = bp.config[k]
    const em = u.eMode ? bp.emode.get(u.eMode) : undefined
    const inEm = !!em && ((em.bitmap >> BigInt(setup.assets[k].id)) & 1n) === 1n
    return {
      record,
      hfExact,
      priceN: (asset: string) => {
        const i = reserves.indexOf(lc(asset))
        return i < 0 ? null : bn.prices[i]
      },
      fee: {
        bonus: inEm ? bp.emodeBonus.get(u.eMode)! : bonusOf(cfg),
        feePct: protocolFeeOf(cfg),
        revision: setup.revision,
      },
      raw: { u, bp, bn, setup },
    }
  }

  /**
   * Not liquidatable at the N prices: test the N-1 prices with every balance accrued to ts(N)
   * (see the header). Returns the record on that basis (priceN := the N-1 price, balances
   * accrued, atN recomputed) when it locates, else null.
   */
  async locateAtNm1(ev: AaveLiquidation, read: AaveRead): Promise<AaveEventRecord | null> {
    const { u, bp, setup } = read.raw
    const P = ev.block - 1
    const held = setup.assets
      .map((a, k) => ({ a, k }))
      .filter(({ k }) => u.reserves[k].aToken > 0n || u.reserves[k].variableDebt > 0n)
    const rd = await multicall(
      this.rpc,
      this.cfg.chain,
      held.map(({ a }) => ({ target: setup.pool, abi: poolAbi, fn: 'getReserveData', args: [a.address] })),
      P,
    )
    const reserveData = rd.map((r) => {
      if (!r.ok) throw new Error(`${this.cfg.chain} getReserveData failed at ${P}`)
      return r.value as {
        liquidityIndex: bigint
        currentLiquidityRate: bigint
        variableBorrowIndex: bigint
        currentVariableBorrowRate: bigint
        lastUpdateTimestamp: number
        aTokenAddress: string
      }
    })
    const scaled = await multicall(
      this.rpc,
      this.cfg.chain,
      reserveData.map((d) => ({ target: d.aTokenAddress, abi: scaledAbi, fn: 'scaledBalanceOf', args: [ev.user] })),
      P,
    )
    const accrue = (t: bigint) => {
      const reserves = u.reserves.map((r) => ({ ...r }))
      held.forEach(({ k }, i) => {
        const d = reserveData[i]
        const last = BigInt(d.lastUpdateTimestamp)
        if (u.reserves[k].aToken > 0n && scaled[i].ok)
          reserves[k].aToken = rayMulFloor(
            scaled[i].value as bigint,
            normalizedIncome(d.currentLiquidityRate, last, d.liquidityIndex, t),
          )
        if (u.reserves[k].variableDebt > 0n)
          reserves[k].variableDebt = rayMulCeil(
            u.scaledVariableDebt[k],
            normalizedDebt(d.currentVariableBorrowRate, last, d.variableBorrowIndex, t),
          )
      })
      return { ...u, reserves }
    }
    // Self-check: accrued to ts(N-1), the math must give back the balances read at N-1.
    if (this.blockTs) {
      const tP = BigInt(await this.blockTs(P))
      const back = accrue(tP)
      const same = held.every(
        ({ k }) =>
          back.reserves[k].aToken === u.reserves[k].aToken &&
          back.reserves[k].variableDebt === u.reserves[k].variableDebt,
      )
      if (!same) {
        this.stats.accrualCheckFailed++
        return null
      }
    }
    const uN = accrue(BigInt(ev.ts))
    const rec = this.record(ev, setup, uN, bp, bp.prices, bp.prices)
    if (!rec.atN.liquidatable) return null
    this.stats.locatedAtNm1++
    return rec
  }
}
