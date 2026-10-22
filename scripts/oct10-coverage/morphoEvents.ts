/**
 * Step 5: every Morpho Blue Liquidate in the owner's CSV, re-read at block N-1.
 *
 * At N-1 (one Multicall3): position(id, borrower), market(id), idToMarketParams(id), oracle.price().
 * At N-1: IRM.borrowRateView(marketParams, market) (needs the market struct, so a second call).
 * At N: oracle.price(). Block N's timestamp from its header.
 *
 * Morpho math (MorphoBalancesLib / SharesMathLib / MathLib):
 *   toAssetsUp(s, A, S) = ceil(s * (A + 1) / (S + 1e6))         VIRTUAL_ASSETS = 1, VIRTUAL_SHARES = 1e6
 *   accrual to ts(N):   interest = A * wTaylorCompounded(rate, ts(N) - lastUpdate) / 1e18
 *   maxBorrow = floor(floor(collateral * price / 1e36) * lltv / 1e18)
 *   liquidatable  iff  borrowed > maxBorrow
 * The CSV's pre_debt is pre-accrual (state at N-1); `borrowedN` here is accrued to ts(N), which is
 * what Morpho.liquidate checks after _accrueInterest.
 */
import { join } from 'path'
import { writeFileSync } from 'fs'
import { gzipSync } from 'zlib'
import type { Hex } from 'viem'
import {
  dec,
  decMulticall,
  enc,
  encMulticall,
  irmAbi,
  morphoAbi,
  morphoOracleAbi,
  MORPHO_BY_CHAIN,
  MULTICALL3,
  revertReason,
  type SubCall,
} from './abi'
import { header, type Ctx } from './ctx'
import { morphoEvents, type MorphoEventRow } from './inputs'
import { KeyedCalls } from './keyed'
import { morphoSetup, type MorphoSetup } from './morphoOracle'
import type { ChainKey } from './rpc'
import { pmap, progress } from './store'

const OUT = 'morpho-events'
const WAD = 10n ** 18n
const SCALE = 10n ** 36n
const ZERO = '0x0000000000000000000000000000000000000000'

const mulDivDown = (x: bigint, y: bigint, d: bigint) => (x * y) / d
const mulDivUp = (x: bigint, y: bigint, d: bigint) => (x * y + (d - 1n)) / d
const toAssetsUp = (s: bigint, A: bigint, S: bigint) => mulDivUp(s, A + 1n, S + 1_000_000n)
const toAssetsDown = (s: bigint, A: bigint, S: bigint) => mulDivDown(s, A + 1n, S + 1_000_000n)
const wTaylor = (x: bigint, n: bigint) => {
  const first = x * n
  const second = mulDivDown(first, first, 2n * WAD)
  const third = mulDivDown(second, first, 3n * WAD)
  return first + second + third
}

function stateCalls(
  morpho: string,
  m: { id: string; oracle: string },
  borrower: string,
): SubCall[] {
  return [
    { target: morpho, abi: morphoAbi, fn: 'position', args: [m.id, borrower] },
    { target: morpho, abi: morphoAbi, fn: 'market', args: [m.id] },
    { target: morpho, abi: morphoAbi, fn: 'idToMarketParams', args: [m.id] },
    { target: m.oracle, abi: morphoOracleAbi, fn: 'price' },
  ]
}

export type MorphoRow = MorphoEventRow & { mkt?: string }
export interface MorphoEventsOpts {
  /** Rows to read (default: the owner's CSV). */
  rows?: MorphoRow[]
  /** Setups by tag (a row's `mkt`, default its chain). */
  setups?: Map<string, MorphoSetup>
  file?: string
  out?: string
  store?: string
  /** Fields appended to each output line (none for the original file). */
  extraFields?: (r: MorphoRow, e: Record<string, unknown>) => Record<string, unknown>
  /** Re-ask every read on a second backend (not a sample). */
  verifyEvery?: boolean
}

const ratio = (num: bigint, den: bigint) =>
  den === 0n ? null : Number((num * 10n ** 12n) / den) / 1e12

export async function morphoEventsStep(ctx: Ctx, chains: ChainKey[], opts: MorphoEventsOpts = {}) {
  const OUTN = opts.out ?? OUT
  const rows: MorphoRow[] =
    opts.rows ?? morphoEvents(ctx.inputsDir).filter((r) => chains.includes(r.chain))
  const tagOf = (r: MorphoRow) => r.mkt ?? r.chain
  const setups = new Map<string, MorphoSetup>(opts.setups ?? [])
  for (const c of [...new Set(rows.map((r) => r.chain))])
    if (!setups.has(c) && rows.some((r) => tagOf(r) === c)) setups.set(c, await morphoSetup(ctx, c))
  const kc = new KeyedCalls(
    ctx,
    OUTN,
    join(ctx.stateDir, opts.store ?? 'morpho-events-calls.jsonl'),
  )
  const sKey = (r: MorphoEventRow) =>
    `st:${r.chain}:${r.market_id}:${r.borrower}:${r.block_number - 1}`
  const pxKey = (r: MorphoEventRow) => `px:${r.chain}:${r.oracle}:${r.block_number}`
  const irmKey = (r: MorphoEventRow) => `irm:${r.chain}:${r.market_id}:${r.block_number - 1}`
  const market = (r: MorphoEventRow) =>
    setups.get(tagOf(r))!.markets.find((m) => m.id === r.market_id)!

  const prog = progress('morpho-events fetch')
  const stateCallsFor = new Map<string, { chain: ChainKey; to: string; data: Hex; block: number }>()
  for (const r of rows) {
    stateCallsFor.set(sKey(r), {
      chain: r.chain,
      to: MULTICALL3,
      data: encMulticall(stateCalls(MORPHO_BY_CHAIN[r.chain], market(r), r.borrower)),
      block: r.block_number - 1,
    })
    stateCallsFor.set(pxKey(r), {
      chain: r.chain,
      to: r.oracle,
      data: enc({ target: r.oracle, abi: morphoOracleAbi, fn: 'price' }),
      block: r.block_number,
    })
  }
  let n = 0
  await kc.fetchAll(
    [...stateCallsFor].map(([key, v]) => ({ key, ...v })),
    10,
    () => prog(++n, stateCallsFor.size),
  )

  const decodeState = (r: MorphoEventRow) => {
    const calls = stateCalls(MORPHO_BY_CHAIN[r.chain], market(r), r.borrower)
    const s = kc.get(sKey(r))!
    if (s.ans.revert) throw new Error('state multicall reverted')
    const res = decMulticall(calls, s.ans.result as Hex)
    for (let k = 0; k < 3; k++)
      if (!res[k].ok) throw new Error(`state sub-call ${k} failed: ${revertReason(res[k].err)}`)
    const [, borrowShares, collateral] = res[0].value as [bigint, bigint, bigint]
    const [
      totalSupplyAssets,
      totalSupplyShares,
      totalBorrowAssets,
      totalBorrowShares,
      lastUpdate,
      fee,
    ] = res[1].value as bigint[]
    const params = res[2].value as [string, string, string, string, bigint]
    const price = res[3].ok ? (res[3].value as bigint) : null
    return {
      borrowShares,
      collateral,
      totalSupplyAssets,
      totalSupplyShares,
      totalBorrowAssets,
      totalBorrowShares,
      lastUpdate,
      fee,
      params,
      price,
      priceErr: res[3].ok ? null : revertReason(res[3].err),
    }
  }

  // IRM borrowRateView at N-1 with the market struct read at N-1.
  const irmCalls: { key: string; chain: ChainKey; to: string; data: Hex; block: number }[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (seen.has(irmKey(r)) || r.irm === ZERO) continue
    seen.add(irmKey(r))
    const st = decodeState(r)
    const [loanToken, collateralToken, oracle, irm, lltv] = st.params
    irmCalls.push({
      key: irmKey(r),
      chain: r.chain,
      to: r.irm,
      data: enc({
        target: r.irm,
        abi: irmAbi,
        fn: 'borrowRateView',
        args: [
          { loanToken, collateralToken, oracle, irm, lltv },
          {
            totalSupplyAssets: st.totalSupplyAssets,
            totalSupplyShares: st.totalSupplyShares,
            totalBorrowAssets: st.totalBorrowAssets,
            totalBorrowShares: st.totalBorrowShares,
            lastUpdate: st.lastUpdate,
            fee: st.fee,
          },
        ],
      }),
      block: r.block_number - 1,
    })
  }
  await kc.fetchAll(irmCalls, 8)
  // Block N headers (timestamps for accrual).
  const headerBlocks = [...new Set(rows.map((r) => `${r.chain}:${r.block_number}`))]
  await pmap(headerBlocks, 8, async (k) => {
    const [c, b] = k.split(':')
    await header(ctx, c as ChainKey, Number(b))
  })

  const evaluate = async (r: MorphoEventRow) => {
    const m = market(r)
    const st = decodeState(r)
    const pxN = kc.get(pxKey(r))!
    const priceN = pxN.ans.revert
      ? null
      : (dec<bigint>({ abi: morphoOracleAbi, fn: 'price' }, pxN.ans.result as Hex) as bigint)
    let rate = 0n
    if (r.irm !== ZERO) {
      const ir = kc.get(irmKey(r))!
      if (ir.ans.revert) throw new Error(`borrowRateView reverted: ${ir.ans.revert.message}`)
      rate = dec<bigint>({ abi: irmAbi, fn: 'borrowRateView' }, ir.ans.result as Hex) as bigint
    }
    const hN = await header(ctx, r.chain, r.block_number)
    const elapsed = BigInt(hN.ts) - st.lastUpdate
    const interest =
      elapsed > 0n && st.totalBorrowAssets > 0n
        ? mulDivDown(st.totalBorrowAssets, wTaylor(rate, elapsed), WAD)
        : 0n
    const borrowedPre = toAssetsUp(st.borrowShares, st.totalBorrowAssets, st.totalBorrowShares)
    // The CSV's pre_debt rounds DOWN (toAssetsDown); Morpho's health check rounds UP.
    const borrowedPreDown = toAssetsDown(
      st.borrowShares,
      st.totalBorrowAssets,
      st.totalBorrowShares,
    )
    const borrowedN = toAssetsUp(
      st.borrowShares,
      st.totalBorrowAssets + interest,
      st.totalBorrowShares,
    )
    const lltv = BigInt(m.lltv)
    const collValue = (p: bigint | null) =>
      p === null ? null : mulDivDown(st.collateral, p, SCALE)
    const maxBorrow = (p: bigint | null) => {
      const v = collValue(p)
      return v === null ? null : mulDivDown(v, lltv, WAD)
    }
    const cvP = collValue(st.price)
    const cvN = collValue(priceN)
    const mbP = maxBorrow(st.price)
    const mbN = maxBorrow(priceN)
    return {
      m,
      st,
      priceN,
      rate,
      hN,
      elapsed,
      interest,
      borrowedPre,
      borrowedPreDown,
      borrowedN,
      cvP,
      cvN,
      mbP,
      mbN,
    }
  }

  for (let round = 0; round < 3; round++) {
    const anomalous = new Set<string>()
    for (const r of rows) {
      try {
        const e = await evaluate(r)
        const csvOk =
          e.st.collateral.toString() === r.pre_collateral_raw &&
          e.st.borrowShares.toString() === r.pre_borrow_shares
        if (
          !csvOk ||
          e.st.price === null ||
          e.st.price === 0n ||
          e.priceN === null ||
          e.priceN === 0n ||
          (e.mbN !== null && e.borrowedN <= e.mbN)
        ) {
          anomalous.add(sKey(r))
          anomalous.add(pxKey(r))
        }
        if (
          e.st.price &&
          e.priceN &&
          Math.abs(Number(e.priceN - e.st.price)) / Number(e.st.price) > 0.2
        ) {
          anomalous.add(sKey(r))
          anomalous.add(pxKey(r))
        }
      } catch {
        anomalous.add(sKey(r))
        anomalous.add(pxKey(r))
        if (r.irm !== ZERO) anomalous.add(irmKey(r))
      }
    }
    const keys = [...stateCallsFor.keys(), ...irmCalls.map((c) => c.key)]
    const changed = await kc.verifyAll(keys, anomalous, 6, !!opts.verifyEvery)
    const req = await kc.requeryTainted(keys)
    process.stderr.write(
      `[morpho-events] verify round ${round}: ${anomalous.size} anomalous keys, ${changed.length + req.length} changed\n`,
    )
    if (!changed.length && !req.length) break
  }

  const lines: string[] = []
  const stats = {
    events: rows.length,
    csvCollateralMatch: 0,
    csvSharesMatch: 0,
    csvSharesMismatchIntraBlock: 0,
    csvPreDebtMatch: 0,
    priceOk: 0,
    liquidatableN: 0,
    notLiquidatableN: 0,
    ltvNAboveLltv: 0,
    liquidatableNm1: 0,
    errors: 0,
    byChain: {} as Record<string, Record<string, number>>,
  }
  for (const r of rows) {
    const bc = (stats.byChain[r.chain] ??= {
      events: 0,
      liquidatableN: 0,
      notLiquidatableN: 0,
      csvCollateralMatch: 0,
      priceMissing: 0,
    })
    bc.events++
    let e: Awaited<ReturnType<typeof evaluate>>
    try {
      e = await evaluate(r)
    } catch (err) {
      stats.errors++
      lines.push(
        JSON.stringify({
          chain: r.chain,
          block_number: r.block_number,
          log_index: r.log_index,
          tx_hash: r.tx_hash,
          borrower: r.borrower,
          market_id: r.market_id,
          error: String((err as Error).message),
        }),
      )
      continue
    }
    const collMatch = e.st.collateral.toString() === r.pre_collateral_raw
    if (collMatch) {
      stats.csvCollateralMatch++
      bc.csvCollateralMatch++
    }
    if (e.st.borrowShares.toString() === r.pre_borrow_shares) stats.csvSharesMatch++
    if (e.borrowedPreDown.toString() === r.pre_debt_assets_raw_preaccrual) stats.csvPreDebtMatch++
    if (e.st.borrowShares.toString() !== r.pre_borrow_shares && Number(r.intra_block_seq) > 1)
      stats.csvSharesMismatchIntraBlock++
    const priced = e.st.price !== null && e.priceN !== null
    if (priced) stats.priceOk++
    else bc.priceMissing++
    const liqN = e.mbN !== null && e.borrowedN > e.mbN
    const liqP = e.mbP !== null && e.borrowedPre > e.mbP
    if (liqN) {
      stats.liquidatableN++
      bc.liquidatableN++
    } else {
      stats.notLiquidatableN++
      bc.notLiquidatableN++
    }
    if (liqP) stats.liquidatableNm1++
    const ltvN = e.cvN === null ? null : ratio(e.borrowedN, e.cvN)
    const ltvP = e.cvP === null ? null : ratio(e.borrowedPre, e.cvP)
    const lltvF = Number(e.m.lltv) / 1e18
    if (ltvN !== null && ltvN > lltvF) stats.ltvNAboveLltv++
    lines.push(
      JSON.stringify({
        chain: r.chain,
        block_number: r.block_number,
        log_index: r.log_index,
        tx_hash: r.tx_hash,
        borrower: r.borrower,
        market_id: r.market_id,
        ts: r.ts,
        tsHeaderN: e.hN.ts,
        oracle: r.oracle,
        loanToken: e.m.loanToken,
        collateralToken: e.m.collateralToken,
        loanDecimals: e.m.loanDecimals,
        collateralDecimals: e.m.collateralDecimals,
        lltv: e.m.lltv,
        blockRead: r.block_number - 1,
        positionNm1: {
          borrowShares: e.st.borrowShares.toString(),
          collateral: e.st.collateral.toString(),
        },
        marketNm1: {
          totalSupplyAssets: e.st.totalSupplyAssets.toString(),
          totalSupplyShares: e.st.totalSupplyShares.toString(),
          totalBorrowAssets: e.st.totalBorrowAssets.toString(),
          totalBorrowShares: e.st.totalBorrowShares.toString(),
          lastUpdate: e.st.lastUpdate.toString(),
          fee: e.st.fee.toString(),
        },
        borrowRatePerSecNm1: e.rate.toString(),
        accrualSeconds: e.elapsed.toString(),
        priceNm1: e.st.price?.toString() ?? null,
        priceNm1Err: e.st.priceErr,
        priceN: e.priceN?.toString() ?? null,
        borrowedNm1PreAccrual: e.borrowedPre.toString(),
        borrowedNm1PreAccrualDown: e.borrowedPreDown.toString(),
        borrowedNAccrued: e.borrowedN.toString(),
        collateralValueNm1: e.cvP?.toString() ?? null,
        collateralValueN: e.cvN?.toString() ?? null,
        maxBorrowNm1: e.mbP?.toString() ?? null,
        maxBorrowN: e.mbN?.toString() ?? null,
        ltvNm1: ltvP,
        ltvN,
        lltvFloat: lltvF,
        liquidatableNm1: liqP,
        liquidatableN: liqN,
        csvMatch: {
          collateral: collMatch,
          borrowShares: e.st.borrowShares.toString() === r.pre_borrow_shares,
          preDebtDown: e.borrowedPreDown.toString() === r.pre_debt_assets_raw_preaccrual,
        },
        // Position read at N-1 (pre-block). For intra_block_seq > 1 an earlier Liquidate in block N
        // already changed it; the first event of the block is the one the N-1 read describes.
        intra_block_seq: r.intra_block_seq,
        hosts: { stateNm1: kc.store.get(sKey(r))!.host, priceN: kc.store.get(pxKey(r))!.host },
        ...(opts.extraFields ? opts.extraFields(r, e as unknown as Record<string, unknown>) : {}),
      }),
    )
  }
  writeFileSync(
    join(ctx.outDir, opts.file ?? 'morpho-events.jsonl.gz'),
    gzipSync(lines.join('\n') + '\n'),
  )
  process.stderr.write(`[morpho-events] ${JSON.stringify({ ...stats, byChain: undefined })}\n`)
  return { ...stats, verification: ctx.verifier.stats(OUTN), calls: kc.store.size }
}
