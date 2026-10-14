/**
 * Morpho Blue reads for the live engine — the Oct 10 pull's event re-read
 * (scripts/oct10-coverage/morphoEvents.ts), one liquidation at a time:
 *
 *   at N-1  position(id, borrower), market(id), idToMarketParams(id), oracle.price()
 *           (one Multicall3), then IRM.borrowRateView(params, market) with that market struct;
 *   at N    oracle.price(); block N's timestamp (from its header) for the accrual.
 *
 * Morpho math, as the pull (MorphoBalancesLib / SharesMathLib / MathLib — copied because the
 * pull keeps them module-private; tests/unit/wavefrontLiveReads.test.ts checks them against
 * recorded pull rows):
 *   toAssetsUp(s, A, S) = ceil(s * (A + 1) / (S + 1e6))
 *   interest to ts(N)   = A * wTaylorCompounded(rate, ts(N) - lastUpdate) / 1e18
 *   maxBorrow           = floor(floor(collateral * price / 1e36) * lltv / 1e18)
 *   liquidatable       iff borrowedN > maxBorrow(price N)
 */
import type { Hex } from 'viem'
import {
  dec,
  enc,
  erc20Abi,
  irmAbi,
  morphoAbi,
  morphoOracleAbi,
  revertReason,
  type SubResult,
} from '../../../scripts/oct10-coverage/abi'
import type { MorphoEventRecord } from '../morpho'
import { ethCall, multicall } from './calls'
import type { MorphoLiquidation } from './codec'
import type { ChainConfig } from './config'
import type { LiveRpc } from './rpc'

const lc = (s: string) => s.toLowerCase()
const WAD = 10n ** 18n
const SCALE = 10n ** 36n
const ZERO = '0x0000000000000000000000000000000000000000'

export const mulDivDown = (x: bigint, y: bigint, d: bigint) => (x * y) / d
export const mulDivUp = (x: bigint, y: bigint, d: bigint) => (x * y + (d - 1n)) / d
export const toAssetsUp = (s: bigint, A: bigint, S: bigint) => mulDivUp(s, A + 1n, S + 1_000_000n)
export const wTaylor = (x: bigint, n: bigint) => {
  const first = x * n
  const second = mulDivDown(first, first, 2n * WAD)
  const third = mulDivDown(second, first, 3n * WAD)
  return first + second + third
}
const ratio = (num: bigint, den: bigint) =>
  den === 0n ? null : Number((num * 10n ** 12n) / den) / 1e12

export interface MorphoMarketLive {
  id: string
  loanToken: string
  collateralToken: string
  oracle: string
  irm: string
  lltv: string
  loanDecimals: number
  collateralDecimals: number
  loanSymbol: string
  collateralSymbol: string
}

/** The pull's borrowed-at-N and liquidatable-at-N from the N-1 reads (pure). */
export function morphoAtN(x: {
  borrowShares: bigint
  collateral: bigint
  totalBorrowAssets: bigint
  totalBorrowShares: bigint
  lastUpdate: bigint
  rate: bigint
  tsN: number
  priceN: bigint | null
  lltv: bigint
}): { borrowedN: bigint; maxBorrowN: bigint | null; liquidatableN: boolean; ltvN: number | null } {
  const elapsed = BigInt(x.tsN) - x.lastUpdate
  const interest =
    elapsed > 0n && x.totalBorrowAssets > 0n
      ? mulDivDown(x.totalBorrowAssets, wTaylor(x.rate, elapsed), WAD)
      : 0n
  const borrowedN = toAssetsUp(x.borrowShares, x.totalBorrowAssets + interest, x.totalBorrowShares)
  const cvN = x.priceN === null ? null : mulDivDown(x.collateral, x.priceN, SCALE)
  const maxBorrowN = cvN === null ? null : mulDivDown(cvN, x.lltv, WAD)
  return {
    borrowedN,
    maxBorrowN,
    liquidatableN: maxBorrowN !== null && borrowedN > maxBorrowN,
    ltvN: cvN === null ? null : ratio(borrowedN, cvN),
  }
}

const symbolOf = (r: SubResult): string => {
  if (r.ok) return String(r.value)
  if (r.raw && r.raw.length === 66)
    return Buffer.from(r.raw.slice(2), 'hex').toString('utf8').replace(/\0+$/, '')
  return ''
}

export interface MorphoReaderStats {
  opens: number
  locatedAtNm1: number
  priceReads: number
  liquidatableN: number
  notLiquidatableN: number
}

export class MorphoReader {
  readonly markets = new Map<string, MorphoMarketLive>()
  private tokens = new Map<string, { decimals: number; symbol: string }>()
  private codeChecked = false
  readonly stats: MorphoReaderStats = {
    opens: 0,
    locatedAtNm1: 0,
    priceReads: 0,
    liquidatableN: 0,
    notLiquidatableN: 0,
  }

  constructor(
    readonly rpc: LiveRpc,
    readonly cfg: ChainConfig,
  ) {}

  /** Morpho Blue must have code on this chain (checked once). */
  async checkCode(block: number) {
    if (this.codeChecked) return
    const a = await this.rpc.request(this.cfg.chain, 'eth_getCode', [
      this.cfg.morpho,
      '0x' + block.toString(16),
    ])
    if (typeof a.result !== 'string' || a.result.length <= 2)
      throw new Error(`${this.cfg.chain}: no Morpho Blue code at ${this.cfg.morpho}`)
    this.codeChecked = true
  }

  /** Market params (immutable) and token metadata. */
  async market(id: string, block: number): Promise<MorphoMarketLive> {
    const got = this.markets.get(id)
    if (got) return got
    const [p] = await multicall(
      this.rpc,
      this.cfg.chain,
      [{ target: this.cfg.morpho, abi: morphoAbi, fn: 'idToMarketParams', args: [id] }],
      block,
    )
    if (!p.ok) throw new Error(`${this.cfg.chain} market ${id}: idToMarketParams failed`)
    const [loanToken, collateralToken, oracle, irm, lltv] = (p.value as unknown[]).map((v) =>
      typeof v === 'string' ? lc(v) : v,
    ) as [string, string, string, string, bigint]
    const need = [loanToken, collateralToken].filter((t) => !this.tokens.has(t))
    if (need.length) {
      const meta = await multicall(
        this.rpc,
        this.cfg.chain,
        need.flatMap((t) => [
          { target: t, abi: erc20Abi, fn: 'decimals' },
          { target: t, abi: erc20Abi, fn: 'symbol' },
        ]),
        block,
      )
      need.forEach((t, k) => {
        if (!meta[2 * k].ok) throw new Error(`${this.cfg.chain} ${t}: decimals() failed`)
        this.tokens.set(t, { decimals: Number(meta[2 * k].value), symbol: symbolOf(meta[2 * k + 1]) })
      })
    }
    const m: MorphoMarketLive = {
      id,
      loanToken,
      collateralToken,
      oracle,
      irm,
      lltv: lltv.toString(),
      loanDecimals: this.tokens.get(loanToken)!.decimals,
      collateralDecimals: this.tokens.get(collateralToken)!.decimals,
      loanSymbol: this.tokens.get(loanToken)!.symbol,
      collateralSymbol: this.tokens.get(collateralToken)!.symbol,
    }
    this.markets.set(id, m)
    return m
  }

  /** oracle.price() at a block; null on a revert (an unreadable oracle is not walked). */
  async price(oracle: string, block: number): Promise<bigint | null> {
    this.stats.priceReads++
    const a = await ethCall(
      this.rpc,
      this.cfg.chain,
      oracle,
      enc({ target: oracle, abi: morphoOracleAbi, fn: 'price' }),
      block,
    )
    if (a.revert || typeof a.result !== 'string' || a.result === '0x') return null
    return dec<bigint>({ abi: morphoOracleAbi, fn: 'price' }, a.result as Hex) as bigint
  }

  /**
   * The pull's per-event record for a Liquidate that opens a position. When the position is not
   * liquidatable at the price read at the END of block N but is at the N-1 price (with the debt
   * accrued to ts(N) — an oracle update later in block N than the liquidation hides the breach),
   * `atNm1` is the record on that basis (priceN := the N-1 price).
   */
  async readOpen(
    ev: MorphoLiquidation,
  ): Promise<{ record: MorphoEventRecord; market: MorphoMarketLive; atNm1: MorphoEventRecord | null }> {
    const P = ev.block - 1
    const m = await this.market(ev.marketId, P)
    const st = await multicall(
      this.rpc,
      this.cfg.chain,
      [
        { target: this.cfg.morpho, abi: morphoAbi, fn: 'position', args: [m.id, ev.borrower] },
        { target: this.cfg.morpho, abi: morphoAbi, fn: 'market', args: [m.id] },
        { target: this.cfg.morpho, abi: morphoAbi, fn: 'idToMarketParams', args: [m.id] },
        { target: m.oracle, abi: morphoOracleAbi, fn: 'price' },
      ],
      P,
    )
    for (let k = 0; k < 3; k++)
      if (!st[k].ok) throw new Error(`state sub-call ${k} failed: ${revertReason(st[k].err)}`)
    const [, borrowShares, collateral] = st[0].value as [bigint, bigint, bigint]
    const mk = st[1].value as bigint[]
    const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] =
      mk
    const params = st[2].value as [string, string, string, string, bigint]
    const priceNm1 = st[3].ok ? (st[3].value as bigint) : null
    let rate = 0n
    if (m.irm !== ZERO) {
      const [loanToken, collateralToken, oracle, irm, lltv] = params
      const a = await ethCall(
        this.rpc,
        this.cfg.chain,
        m.irm,
        enc({
          target: m.irm,
          abi: irmAbi,
          fn: 'borrowRateView',
          args: [
            { loanToken, collateralToken, oracle, irm, lltv },
            { totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee },
          ],
        }),
        P,
      )
      if (a.revert) throw new Error(`borrowRateView reverted: ${a.revert.message}`)
      rate = dec<bigint>({ abi: irmAbi, fn: 'borrowRateView' }, a.result as Hex) as bigint
    }
    const priceN = await this.price(m.oracle, ev.block)
    const x = morphoAtN({
      borrowShares,
      collateral,
      totalBorrowAssets,
      totalBorrowShares,
      lastUpdate,
      rate,
      tsN: ev.ts,
      priceN,
      lltv: BigInt(m.lltv),
    })
    this.stats.opens++
    if (x.liquidatableN) this.stats.liquidatableN++
    else this.stats.notLiquidatableN++
    const record: MorphoEventRecord = {
      chain: ev.chain,
      block_number: ev.block,
      log_index: ev.logIndex,
      tx_hash: ev.tx,
      borrower: ev.borrower,
      market_id: ev.marketId,
      ts: ev.ts,
      oracle: m.oracle,
      loanToken: m.loanToken,
      collateralToken: m.collateralToken,
      loanDecimals: m.loanDecimals,
      collateralDecimals: m.collateralDecimals,
      lltv: m.lltv,
      positionNm1: { borrowShares: borrowShares.toString(), collateral: collateral.toString() },
      priceN: priceN?.toString() ?? null,
      borrowedNAccrued: x.borrowedN.toString(),
      ltvN: x.ltvN,
      liquidatableN: x.liquidatableN,
    }
    let atNm1: MorphoEventRecord | null = null
    if (!x.liquidatableN && priceNm1 !== null && priceNm1 > 0n) {
      const y = morphoAtN({
        borrowShares,
        collateral,
        totalBorrowAssets,
        totalBorrowShares,
        lastUpdate,
        rate,
        tsN: ev.ts,
        priceN: priceNm1,
        lltv: BigInt(m.lltv),
      })
      if (y.liquidatableN) {
        this.stats.locatedAtNm1++
        atNm1 = {
          ...record,
          priceN: priceNm1.toString(),
          borrowedNAccrued: y.borrowedN.toString(),
          ltvN: y.ltvN,
          liquidatableN: true,
        }
      }
    }
    return { record, market: m, atNm1 }
  }

  /** The minimal record the real side needs for a later Liquidate (price at its own N). */
  async readLater(ev: MorphoLiquidation): Promise<MorphoEventRecord> {
    const m = await this.market(ev.marketId, ev.block - 1)
    const priceN = await this.price(m.oracle, ev.block)
    return {
      chain: ev.chain,
      block_number: ev.block,
      log_index: ev.logIndex,
      tx_hash: ev.tx,
      borrower: ev.borrower,
      market_id: ev.marketId,
      ts: ev.ts,
      oracle: m.oracle,
      loanToken: m.loanToken,
      collateralToken: m.collateralToken,
      loanDecimals: m.loanDecimals,
      collateralDecimals: m.collateralDecimals,
      lltv: m.lltv,
      positionNm1: { borrowShares: '0', collateral: '0' },
      priceN: priceN?.toString() ?? null,
      borrowedNAccrued: null,
      ltvN: null,
      liquidatableN: false,
    }
  }
}
