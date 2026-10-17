/**
 * Fees step: the Aave liquidation protocol fee of EVERY Aave event (the owner's CSV rows and the
 * scope scan's extra rows), computed and checked against the fee actually paid on chain.
 *
 * Aave V3 LiquidationLogic (executeLiquidationCall -> _calculateAvailableCollateralToLiquidate;
 * aave-v3-origin v3.3-v3.5):
 *     collateralAmount   = min(baseCollateral.percentMul(liquidationBonus), userCollateralBalance)
 *     bonusCollateral    = collateralAmount - collateralAmount.percentDiv(liquidationBonus)
 *     liquidationProtocolFee = bonusCollateral.percentMul(liquidationProtocolFeePercentage)
 *     collateralToLiquidate  = collateralAmount - liquidationProtocolFee      (the event's
 *                                                                             liquidatedCollateralAmount)
 * and the fee is moved as collateral aTokens from the user to RESERVE_TREASURY_ADDRESS with
 * aToken.transferOnLiquidation, which emits Transfer(user, treasury, fee).
 * liquidationBonus is the user's e-mode category bonus when the collateral is in that category's
 * collateral bitmap (v3.2+), else the reserve's (configuration bits 32-47).
 *
 * The event gives collateralToLiquidate = C - fee(C); C is recovered by inverting that (C - fee(C)
 * is non-decreasing in steps of 0 or 1, so a solution always exists; when two C solve it the fee
 * is ambiguous by one unit and both are recorded). The rounding of percentDiv / percentMul is
 * settled on chain: every variant is computed and scored against the treasury Transfer of every
 * event's own transaction receipt.
 *
 * Reads at block N: PoolDataProvider.getLiquidationProtocolFee(collateral), Pool.getConfiguration
 * (collateral), the user's e-mode category collateral config + bitmap (one Multicall3 per
 * event); the aToken and treasury addresses at the window start; the receipt of every tx.
 */
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { gunzipSync, gzipSync } from 'zlib'
import type { Hex } from 'viem'
import {
  aTokenAbi,
  dataProviderAbi,
  decMulticall,
  encMulticall,
  LIQUIDATION_CALL_TOPIC,
  MULTICALL3,
  poolAbi,
  type SubCall,
} from './abi'
import { aaveSetupFor, coreMarket, type AaveMarket, type AaveSetup } from './aaveOracle'
import type { Ctx } from './ctx'
import { aaveEvents } from './inputs'
import { KeyedCalls } from './keyed'
import type { ChainKey, RpcAnswer } from './rpc'
import { loadScope } from './scope'
import { setupMulticall } from './setupCall'
import { JsonlStore, pmap, progress, writeJson } from './store'
import { inSample, type Stored } from './verify'

const OUT = 'aave-protocol-fee'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const lc = (s: string) => s.toLowerCase()
const pad = (a: string) => '0x' + a.slice(2).padStart(64, '0')

type Mode = 'half' | 'floor' | 'ceil'
const MODES: Mode[] = ['half', 'floor', 'ceil']
const pMul = (v: bigint, p: bigint, m: Mode) =>
  m === 'half'
    ? (v * p + 5000n) / 10000n
    : m === 'floor'
      ? (v * p) / 10000n
      : (v * p + 9999n) / 10000n
const pDiv = (v: bigint, p: bigint, m: Mode) =>
  m === 'half'
    ? (v * 10000n + p / 2n) / p
    : m === 'floor'
      ? (v * 10000n) / p
      : (v * 10000n + p - 1n) / p
const RAY = 10n ** 27n
/** What a transfer of `fee` aTokens moves when the aToken rounds through scaled balances
 *  (v3.5: scaled = rayDivFloor(fee, index), moved = rayMulFloor(scaled, index)). */
export const scaledFloor = (fee: bigint, index: bigint) => (((fee * RAY) / index) * index) / RAY
const feeOf = (c: bigint, bonus: bigint, pct: bigint, dm: Mode, mm: Mode) =>
  pMul(c - pDiv(c, bonus, dm), pct, mm)

/** Every fee consistent with collateralToLiquidate = L under one rounding variant. */
export function feesFor(L: bigint, bonus: bigint, pct: bigint, dm: Mode, mm: Mode): bigint[] {
  if (pct === 0n) return [0n]
  const g = (c: bigint) => c - feeOf(c, bonus, pct, dm, mm)
  let lo = L
  let hi = 2n * L + 10n
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    if (g(mid) >= L) hi = mid
    else lo = mid + 1n
  }
  const out: bigint[] = []
  for (let c = lo; g(c) === L && out.length < 3; c++) out.push(c - L)
  return out
}

interface Ev {
  chain: ChainKey
  tag: string
  market: string
  pool: string
  block_number: number
  log_index: number
  tx_hash: string
  user: string
  collateral_asset: string
  debt_asset: string
  liquidated: bigint
  debtToCover: bigint
}

interface Receipt {
  status: string
  logs: [number, string, string[], string][]
  host: string
  group: string
}
const receiptNorm = (a: RpcAnswer) => {
  if (a.revert) return 'REVERT'
  const r = a.result as {
    status: string
    logs: { logIndex: string; address: string; topics: string[]; data: string }[]
  }
  return JSON.stringify({
    status: r.status,
    logs: r.logs.map((l) => [
      Number(BigInt(l.logIndex)),
      lc(l.address),
      l.topics.map(lc),
      lc(l.data),
    ]),
  })
}

function readLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  return gunzipSync(readFileSync(path))
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

export async function feesStep(ctx: Ctx, chains: ChainKey[]) {
  const scope = loadScope(ctx)
  // Events: the owner's rows (core markets) + the scope scan's extras.
  const evs: Ev[] = [
    ...aaveEvents(ctx.inputsDir)
      .filter((r) => chains.includes(r.chain))
      .map((r) => ({
        chain: r.chain,
        tag: r.chain as string,
        market: 'core',
        pool: '',
        block_number: r.block_number,
        log_index: r.log_index,
        tx_hash: r.tx_hash,
        user: r.user,
        collateral_asset: r.collateral_asset,
        debt_asset: r.debt_asset,
        liquidated: BigInt(String(r.liquidated_collateral_raw)),
        debtToCover: BigInt(String(r.debt_to_cover_raw)),
      })),
    ...scope.extraAave
      .filter((e) => chains.includes(e.chain))
      .map((e) => ({
        chain: e.chain,
        tag: e.market === 'core' ? e.chain : `${e.chain}.${e.market}`,
        market: e.market,
        pool: e.pool,
        block_number: e.block_number,
        log_index: e.log_index,
        tx_hash: e.tx_hash,
        user: e.user,
        collateral_asset: e.collateral_asset,
        debt_asset: e.debt_asset,
        liquidated: BigInt(e.liquidated_collateral_raw),
        debtToCover: BigInt(e.debt_to_cover_raw),
      })),
  ]
  // e-mode at N-1 from the event re-reads.
  const emodeOf = new Map<string, number>()
  for (const f of ['aave-events.jsonl.gz', 'aave-events-extra.jsonl.gz'])
    for (const l of readLines(join(ctx.outDir, f)))
      emodeOf.set(`${l.chain}:${l.tx_hash}:${l.log_index}`, Number(l.eMode))
  // Setups per market.
  const setups = new Map<string, AaveSetup>()
  for (const t of [...new Set(evs.map((e) => e.tag))]) {
    const [chain, key] = t.split('.') as [ChainKey, string | undefined]
    const m: AaveMarket = key
      ? {
          chain,
          key,
          provider: scope.markets.find((x) => x.chain === chain && x.key === key)!.provider,
        }
      : coreMarket(chain)
    setups.set(t, await aaveSetupFor(ctx, m))
  }
  for (const e of evs) if (!e.pool) e.pool = setups.get(e.tag)!.pool
  // aToken + treasury per (market, collateral), at the window start.
  const aTok = new Map<string, { aToken: string; treasury: string }>()
  for (const [t, st] of setups) {
    const colls = [...new Set(evs.filter((e) => e.tag === t).map((e) => e.collateral_asset))]
    const rd = await setupMulticall(
      ctx,
      OUT,
      st.chain,
      colls.map((a) => ({ target: st.pool, abi: poolAbi, fn: 'getReserveData', args: [a] })),
      st.b0,
    )
    const toks = colls.map((_, k) =>
      lc(String((rd[k].value as { aTokenAddress: string }).aTokenAddress)),
    )
    const tr = await setupMulticall(
      ctx,
      OUT,
      st.chain,
      toks.map((a) => ({ target: a, abi: aTokenAbi, fn: 'RESERVE_TREASURY_ADDRESS' })),
      st.b0,
    )
    colls.forEach((a, k) =>
      aTok.set(`${t}:${a}`, { aToken: toks[k], treasury: lc(String(tr[k].value)) }),
    )
  }

  // Per-event config multicall at N.
  const kc = new KeyedCalls(ctx, OUT, join(ctx.stateDir, 'fee-calls.jsonl'))
  const callsFor = (e: Ev): SubCall[] => {
    const st = setups.get(e.tag)!
    const em = emodeOf.get(`${e.chain}:${e.tx_hash}:${e.log_index}`) ?? 0
    return [
      {
        target: st.dataProvider,
        abi: dataProviderAbi,
        fn: 'getLiquidationProtocolFee',
        args: [e.collateral_asset],
      },
      { target: st.pool, abi: poolAbi, fn: 'getConfiguration', args: [e.collateral_asset] },
      {
        target: st.pool,
        abi: poolAbi,
        fn: 'getReserveNormalizedIncome',
        args: [e.collateral_asset],
      },
      ...(em
        ? [
            { target: st.pool, abi: poolAbi, fn: 'getEModeCategoryCollateralConfig', args: [em] },
            { target: st.pool, abi: poolAbi, fn: 'getEModeCategoryCollateralBitmap', args: [em] },
          ]
        : []),
    ]
  }
  const fKey = (e: Ev) =>
    `fee2:${e.tag}:${e.block_number}:${e.collateral_asset}:${emodeOf.get(`${e.chain}:${e.tx_hash}:${e.log_index}`) ?? 0}`
  const fcalls = new Map<string, Ev>()
  for (const e of evs) fcalls.set(fKey(e), e)
  const prog = progress('fees fetch')
  let n = 0
  const total = fcalls.size
  await kc.fetchAll(
    [...fcalls].map(([key, e]) => ({
      key,
      chain: e.chain,
      to: MULTICALL3,
      data: encMulticall(callsFor(e)),
      block: e.block_number,
    })),
    10,
    () => prog(++n, total),
  )

  // Receipts of every transaction.
  const rstore = new JsonlStore<Receipt>(join(ctx.stateDir, 'receipts.jsonl'))
  const txs = [...new Set(evs.map((e) => `${e.chain}:${e.tx_hash}`))]
  const rprog = progress('fees receipts')
  let rn = 0
  const saveReceipt = (k: string, a: RpcAnswer) => {
    const r = a.result as {
      status: string
      logs: { logIndex: string; address: string; topics: string[]; data: string }[]
    }
    rstore.put(k, {
      status: r.status,
      logs: r.logs.map((l) => [
        Number(BigInt(l.logIndex)),
        lc(l.address),
        l.topics.map(lc),
        lc(l.data),
      ]),
      host: a.host,
      group: a.group,
    })
  }
  await pmap(
    txs.filter((k) => !rstore.has(k)),
    10,
    async (k) => {
      const [chain, tx] = k.split(':') as [ChainKey, string]
      saveReceipt(k, await ctx.pool.request(chain, 'eth_getTransactionReceipt', [tx]))
      rprog(++rn, txs.length)
    },
  )
  const receiptStored = (k: string): Stored => {
    const r = rstore.get(k)!
    const ans: RpcAnswer = {
      result: {
        status: r.status,
        logs: r.logs.map(([i, address, topics, data]) => ({
          logIndex: '0x' + i.toString(16),
          address,
          topics,
          data,
        })),
      },
      host: r.host,
      group: r.group,
    }
    return { norm: receiptNorm(ans), host: r.host, group: r.group, ans }
  }

  const evaluate = (e: Ev) => {
    const st = setups.get(e.tag)!
    const res = decMulticall(callsFor(e), kc.get(fKey(e))!.ans.result as Hex)
    if (!res[0].ok || !res[1].ok || !res[2].ok) throw new Error('fee config read failed')
    const pct = res[0].value as bigint
    const cfg = (res[1].value as { data: bigint }).data
    const index = res[2].value as bigint
    const reserveBonus = (cfg >> 32n) & 0xffffn
    const em = emodeOf.get(`${e.chain}:${e.tx_hash}:${e.log_index}`) ?? 0
    const id = BigInt(st.assets.find((a) => a.address === e.collateral_asset)!.id)
    let bonus = reserveBonus
    let bonusSource = 'reserve'
    if (em && res[3]?.ok && res[4]?.ok) {
      const bitmap = res[4].value as bigint
      if (((bitmap >> id) & 1n) === 1n) {
        bonus = BigInt((res[3].value as { liquidationBonus: number }).liquidationBonus)
        bonusSource = `e-mode ${em}`
      }
    }
    // Actual fee: Transfer(user -> treasury) by the collateral aToken, after the previous
    // LiquidationCall of this tx and before this one.
    const r = rstore.get(`${e.chain}:${e.tx_hash}`)!
    const at = aTok.get(`${e.tag}:${e.collateral_asset}`)!
    const prevLiq = Math.max(
      -1,
      ...r.logs
        .filter((l) => l[2][0] === LIQUIDATION_CALL_TOPIC && l[0] < e.log_index)
        .map((l) => l[0]),
    )
    const own = r.logs.find((l) => l[0] === e.log_index)
    const ownOk =
      !!own &&
      own[2][0] === LIQUIDATION_CALL_TOPIC &&
      own[1] === lc(e.pool) &&
      own[2][3] === pad(e.user)
    const transfers = r.logs.filter(
      (l) =>
        l[1] === at.aToken &&
        l[2][0] === TRANSFER_TOPIC &&
        l[2][1] === pad(e.user) &&
        l[2][2] === pad(at.treasury) &&
        l[0] > prevLiq &&
        l[0] < e.log_index,
    )
    const actual = transfers.length ? BigInt(transfers[transfers.length - 1][3]) : null
    const variants: Record<string, string[]> = {}
    for (const dm of MODES)
      for (const mm of MODES)
        variants[`div-${dm}/mul-${mm}`] = feesFor(e.liquidated, bonus, pct, dm, mm).map(String)
    return {
      pct,
      bonus,
      bonusSource,
      reserveBonus,
      index,
      actual,
      transfers: transfers.length,
      ownOk,
      receiptStatus: r.status,
      at,
      variants,
    }
  }

  // Score the rounding variants on every event with a treasury transfer (or fee 0).
  const score: Record<string, { exact: number; withinCandidates: number; compared: number }> = {}
  const evals = new Map<Ev, ReturnType<typeof evaluate>>()
  for (const e of evs) evals.set(e, evaluate(e))
  const scaledScore = { compared: 0, transferEqualsFee: 0, transferEqualsScaledFloor: 0 }
  for (const [, v] of evals) {
    const actual = v.actual ?? (v.pct === 0n ? 0n : null)
    if (actual === null) continue
    for (const [name, c] of Object.entries(v.variants)) {
      const s = (score[name] ??= { exact: 0, withinCandidates: 0, compared: 0 })
      s.compared++
      if (c.length === 1 && c[0] === actual.toString()) s.exact++
      if (
        c.includes(actual.toString()) ||
        c.some((x) => scaledFloor(BigInt(x), v.index) === actual)
      )
        s.withinCandidates++
    }
  }
  const best =
    Object.entries(score).sort(
      (a, b) => b[1].withinCandidates - a[1].withinCandidates || b[1].exact - a[1].exact,
    )[0]?.[0] ?? 'div-half/mul-half'

  // Verification: receipts and config calls, sample + anomalies (no transfer where a fee is due,
  // computed fee not matching the transfer, own LiquidationCall not where the scan put it).
  const anomalies = new Set<string>()
  const anomalousTx = new Set<string>()
  for (const [e, v] of evals) {
    const c = v.variants[best]
    const fits = (x: bigint) =>
      c.includes(x.toString()) || c.some((y) => scaledFloor(BigInt(y), v.index) === x)
    const bad =
      !v.ownOk ||
      v.receiptStatus !== '0x1' ||
      (v.pct !== 0n && v.actual === null) ||
      (v.actual !== null && !fits(v.actual))
    if (bad) {
      anomalies.add(fKey(e))
      anomalousTx.add(`${e.chain}:${e.tx_hash}`)
    }
  }
  await kc.verifyAll([...fcalls.keys()], anomalies)
  const rpicks = txs.filter(
    (k) => (inSample(k) || anomalousTx.has(k)) && !ctx.verifier.checked(OUT, `receipt:${k}`),
  )
  await pmap(rpicks, 6, async (k) => {
    const [chain, tx] = k.split(':') as [ChainKey, string]
    const { keep, record } = await ctx.verifier.check(
      OUT,
      chain,
      `receipt:${k}`,
      'eth_getTransactionReceipt',
      [tx],
      receiptStored(k),
      anomalousTx.has(k) ? 'anomaly' : 'sample',
      receiptNorm,
    )
    if (record.resolution === 'check') saveReceipt(k, keep.ans)
  })
  for (const e of evs) evals.set(e, evaluate(e))

  // Output.
  const lines: string[] = []
  const stats = {
    events: evs.length,
    byMarket: {} as Record<string, number>,
    feeNonZero: 0,
    treasuryTransferFound: 0,
    computedEqualsTransfer: 0,
    computedEqualsTransferAfterScaledRounding: 0,
    computedAmbiguousOneUnit: 0,
    computedMismatch: 0,
    feeZeroNoTransfer: 0,
    missingTransfer: 0,
    bonusFromEMode: 0,
    roundingVariantScores: score,
    roundingVariantUsed: best,
    transferVsFee: scaledScore,
  }
  for (const e of evs) {
    const v = evals.get(e)!
    stats.byMarket[e.tag] = (stats.byMarket[e.tag] ?? 0) + 1
    const cands = v.variants[best]
    const computed = BigInt(cands[0])
    if (v.pct !== 0n) stats.feeNonZero++
    if (v.bonusSource !== 'reserve') stats.bonusFromEMode++
    let match: string
    if (v.actual !== null) {
      stats.treasuryTransferFound++
      scaledScore.compared++
      if (cands.includes(v.actual.toString())) {
        stats.computedEqualsTransfer++
        scaledScore.transferEqualsFee++
        if (cands.length > 1) stats.computedAmbiguousOneUnit++
        match = 'equal'
      } else if (cands.some((y) => scaledFloor(BigInt(y), v.index) === v.actual)) {
        stats.computedEqualsTransferAfterScaledRounding++
        scaledScore.transferEqualsScaledFloor++
        match = 'equal-after-scaled-rounding'
      } else {
        stats.computedMismatch++
        match = 'mismatch'
      }
    } else if (v.pct === 0n) {
      stats.feeZeroNoTransfer++
      match = 'fee-zero'
    } else {
      stats.missingTransfer++
      match = 'no-transfer-found'
    }
    const fee = v.actual ?? computed
    lines.push(
      JSON.stringify({
        chain: e.chain,
        market: e.market,
        pool: e.pool,
        block_number: e.block_number,
        log_index: e.log_index,
        tx_hash: e.tx_hash,
        user: e.user,
        collateral_asset: e.collateral_asset,
        debt_asset: e.debt_asset,
        liquidationProtocolFeeBpsN: Number(v.pct),
        liquidationBonusBps: Number(v.bonus),
        liquidationBonusSource: v.bonusSource,
        reserveLiquidationBonusBps: Number(v.reserveBonus),
        liquidatedCollateralRaw: e.liquidated.toString(),
        protocolFeeComputedRaw: cands.map(String),
        protocolFeeComputedAfterScaledRoundingRaw: cands.map((y) =>
          scaledFloor(BigInt(y), v.index).toString(),
        ),
        collateralNormalizedIncomeN: v.index.toString(),
        treasuryTransferRaw: v.actual?.toString() ?? null,
        protocolFeeRaw: fee.toString(),
        protocolFeeSource:
          v.actual !== null
            ? 'treasury Transfer in the tx receipt'
            : v.pct === 0n
              ? 'fee 0'
              : 'computed',
        collateralSeizedTotalRaw: (e.liquidated + fee).toString(),
        match,
        aToken: v.at.aToken,
        treasury: v.at.treasury,
        hosts: {
          config: kc.store.get(fKey(e))!.host,
          receipt: rstore.get(`${e.chain}:${e.tx_hash}`)!.host,
        },
      }),
    )
  }
  writeFileSync(join(ctx.outDir, 'aave-protocol-fee.jsonl.gz'), gzipSync(lines.join('\n') + '\n'))
  const out = {
    ...stats,
    verification: ctx.verifier.stats(OUT),
    calls: kc.store.size,
    receipts: rstore.size,
  }
  writeJson(join(ctx.stateDir, 'fees.summary.json'), out)
  process.stderr.write(`[fees] ${JSON.stringify({ ...stats, roundingVariantScores: undefined })}\n`)
  return out
}
