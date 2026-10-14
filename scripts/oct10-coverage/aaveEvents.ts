/**
 * Step 4: every Aave V3 LiquidationCall in the owner's CSV, re-read at block N-1.
 *
 * Per (chain, user, N-1), one Multicall3: Pool.getUserAccountData, Pool.getUserEMode,
 * Pool.getUserConfiguration, and PoolDataProvider.getUserReserveData for EVERY reserve.
 * Per (chain, block) for N-1 and N, one Multicall3: AaveOracle.getAssetsPrices(reserves),
 * Pool.getConfiguration for every reserve, and every e-mode category's collateral config and
 * collateral bitmap (Aave >= 3.2; all four pools are revision 9 in the window).
 *
 * Health factor is recomputed exactly as GenericLogic.calculateUserAccountData with the v3.5
 * rounding these pools run (revision 9; established empirically: it reproduces all 3,111
 * getUserAccountData health factors to the wei, the v3.2-3.4 half-up percentMul/wadDiv form
 * reproduced none):
 *   for each reserve i the user's config flags:
 *     collateral (bit 2i+1) and reserve LT != 0:
 *        bal = floor(aTokenBalance * price / 10^decimals)
 *        totalCollateral += bal
 *        S += bal * (eMode != 0 && bitmap(eMode) has bit i ? eModeLT : LT)
 *     borrowing (bit 2i):  totalDebt += ceil((variableDebt [+ stableDebt]) * price / 10^decimals)
 *   avgLT = floor(S / totalCollateral);  HF = floor(S * 1e18 / (totalDebt * 1e4))
 * and must equal getUserAccountData's healthFactor at N-1. HF at N uses the N-1 composition and
 * LTs with block-N prices.
 */
import { join } from 'path'
import { writeFileSync } from 'fs'
import { gzipSync } from 'zlib'
import type { Hex } from 'viem'
import {
  dataProviderAbi,
  decMulticall,
  encMulticall,
  MULTICALL3,
  oracleAbi,
  poolAbi,
  revertReason,
  type SubCall,
  type SubResult,
} from './abi'
import { aaveSetup, type AaveSetup } from './aaveOracle'
import type { Ctx } from './ctx'
import { aaveEvents, type AaveEventRow } from './inputs'
import { KeyedCalls } from './keyed'
import type { ChainKey } from './rpc'
import { progress } from './store'

const OUT = 'aave-events'
const WAD = 10n ** 18n
const MAX_U256 = 2n ** 256n - 1n

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b

function blockCalls(setup: AaveSetup): SubCall[] {
  const cats = [...new Set([...setup.emodeStart, ...setup.emodeEnd].map((c) => c.id))].sort(
    (a, b) => a - b,
  )
  return [
    { target: setup.oracle, abi: oracleAbi, fn: 'getAssetsPrices', args: [setup.reserves] },
    ...setup.reserves.map((a) => ({
      target: setup.pool,
      abi: poolAbi,
      fn: 'getConfiguration',
      args: [a],
    })),
    ...cats.flatMap((id) => [
      { target: setup.pool, abi: poolAbi, fn: 'getEModeCategoryCollateralConfig', args: [id] },
      { target: setup.pool, abi: poolAbi, fn: 'getEModeCategoryCollateralBitmap', args: [id] },
    ]),
  ]
}
const emodeIds = (setup: AaveSetup) =>
  [...new Set([...setup.emodeStart, ...setup.emodeEnd].map((c) => c.id))].sort((a, b) => a - b)
const perAssetPriceCalls = (setup: AaveSetup): SubCall[] =>
  setup.reserves.map((a) => ({
    target: setup.oracle,
    abi: oracleAbi,
    fn: 'getAssetPrice',
    args: [a],
  }))

function userCalls(setup: AaveSetup, user: string): SubCall[] {
  return [
    { target: setup.pool, abi: poolAbi, fn: 'getUserAccountData', args: [user] },
    { target: setup.pool, abi: poolAbi, fn: 'getUserEMode', args: [user] },
    { target: setup.pool, abi: poolAbi, fn: 'getUserConfiguration', args: [user] },
    ...setup.reserves.map((a) => ({
      target: setup.dataProvider,
      abi: dataProviderAbi,
      fn: 'getUserReserveData',
      args: [a, user],
    })),
  ]
}

interface BlockState {
  prices: (bigint | null)[]
  priceErr: (string | null)[]
  config: bigint[]
  emode: Map<number, { lt: bigint; ltv: bigint; bitmap: bigint }>
}

function decodeBlock(
  setup: AaveSetup,
  calls: SubCall[],
  res: SubResult[],
  perAsset?: SubResult[],
): BlockState {
  const R = setup.reserves.length
  let prices: (bigint | null)[]
  let priceErr: (string | null)[] = Array(R).fill(null)
  if (res[0].ok) prices = [...(res[0].value as readonly bigint[])]
  else if (perAsset) {
    prices = perAsset.map((r) => (r.ok ? (r.value as bigint) : null))
    priceErr = perAsset.map((r) => (r.ok ? null : revertReason(r.err)))
  } else {
    prices = Array(R).fill(null)
    priceErr = Array(R).fill('getAssetsPrices reverted')
  }
  const config = setup.reserves.map((_, k) => {
    const r = res[1 + k]
    if (!r.ok) throw new Error(`getConfiguration failed for ${setup.reserves[k]}`)
    return (r.value as { data: bigint }).data
  })
  const emode = new Map<number, { lt: bigint; ltv: bigint; bitmap: bigint }>()
  emodeIds(setup).forEach((id, k) => {
    const c = res[1 + R + 2 * k]
    const b = res[1 + R + 2 * k + 1]
    if (!c.ok || !b.ok) throw new Error(`e-mode ${id} read failed`)
    const v = c.value as { ltv: number; liquidationThreshold: number }
    emode.set(id, {
      lt: BigInt(v.liquidationThreshold),
      ltv: BigInt(v.ltv),
      bitmap: b.value as bigint,
    })
  })
  void calls
  return { prices, priceErr, config, emode }
}

interface UserState {
  account: {
    totalCollateralBase: bigint
    totalDebtBase: bigint
    availableBorrowsBase: bigint
    currentLiquidationThreshold: bigint
    ltv: bigint
    healthFactor: bigint
  }
  eMode: number
  userConfig: bigint
  reserves: {
    aToken: bigint
    stableDebt: bigint
    variableDebt: bigint
    usageAsCollateralEnabled: boolean
  }[]
}

function decodeUser(setup: AaveSetup, res: SubResult[]): UserState {
  for (const [k, r] of res.entries())
    if (!r.ok) throw new Error(`user multicall sub-call ${k} failed: ${revertReason(r.err)}`)
  const a = res[0].value as readonly bigint[]
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
    reserves: setup.reserves.map((_, k) => {
      const v = res[3 + k].value as readonly unknown[]
      return {
        aToken: v[0] as bigint,
        stableDebt: v[1] as bigint,
        variableDebt: v[2] as bigint,
        usageAsCollateralEnabled: v[8] as boolean,
      }
    }),
  }
}

const ltOf = (cfg: bigint) => (cfg >> 16n) & 0xffffn
const ltvOf = (cfg: bigint) => cfg & 0xffffn
const decimalsOf = (cfg: bigint) => Number((cfg >> 48n) & 0xffn)

export interface HfCalc {
  totalCollateralBase: bigint
  totalDebtBase: bigint
  avgLT: bigint
  healthFactor: bigint
  missingPrice: string[]
}

function computeHf(
  setup: AaveSetup,
  u: UserState,
  b: BlockState,
  prices: (bigint | null)[],
): HfCalc {
  let coll = 0n
  let debt = 0n
  let avg = 0n
  const missingPrice: string[] = []
  const em = u.eMode ? b.emode.get(u.eMode) : undefined
  if (u.eMode && !em) throw new Error(`user e-mode ${u.eMode} not among the categories read`)
  setup.assets.forEach((asset, k) => {
    const id = BigInt(asset.id)
    const borrowing = (u.userConfig >> (2n * id)) & 1n
    const collat = (u.userConfig >> (2n * id + 1n)) & 1n
    if (!borrowing && !collat) return
    const cfg = b.config[k]
    const lt = ltOf(cfg)
    const unit = 10n ** BigInt(decimalsOf(cfg))
    const price = prices[k]
    const r = u.reserves[k]
    if (price === null) {
      missingPrice.push(asset.address)
      return
    }
    if (lt !== 0n && collat) {
      const bal = (r.aToken * price) / unit
      coll += bal
      const inEm = !!em && ((em.bitmap >> id) & 1n) === 1n
      avg += bal * (inEm ? em!.lt : lt)
    }
    if (borrowing) debt += ceilDiv((r.variableDebt + r.stableDebt) * price, unit)
  })
  const avgLT = coll ? avg / coll : 0n
  const hf = debt === 0n ? MAX_U256 : (avg * WAD) / (debt * 10000n)
  return { totalCollateralBase: coll, totalDebtBase: debt, avgLT, healthFactor: hf, missingPrice }
}

const relDiff = (a: bigint, b: bigint) =>
  a === b ? 0 : Math.abs(Number(a - b)) / Math.max(Math.abs(Number(a)), Math.abs(Number(b)), 1)

export async function aaveEventsStep(ctx: Ctx, chains: ChainKey[]) {
  const rows = aaveEvents(ctx.inputsDir).filter((r) => chains.includes(r.chain))
  const kc = new KeyedCalls(ctx, OUT, join(ctx.stateDir, 'aave-events-calls.jsonl'))
  const setups = new Map<ChainKey, AaveSetup>()
  for (const c of chains) setups.set(c, await aaveSetup(ctx, c))

  const bKey = (chain: ChainKey, b: number) => `blk:${chain}:${b}`
  const pKey = (chain: ChainKey, b: number) => `blkpx:${chain}:${b}`
  const uKey = (chain: ChainKey, user: string, b: number) => `usr:${chain}:${user}:${b}`

  const blockSet = new Map<string, { chain: ChainKey; b: number }>()
  const userSet = new Map<string, { chain: ChainKey; user: string; b: number }>()
  for (const r of rows) {
    for (const b of [r.block_number - 1, r.block_number])
      blockSet.set(bKey(r.chain, b), { chain: r.chain, b })
    userSet.set(uKey(r.chain, r.user, r.block_number - 1), {
      chain: r.chain,
      user: r.user,
      b: r.block_number - 1,
    })
  }
  process.stderr.write(
    `[aave-events] ${rows.length} events, ${blockSet.size} (chain,block) states, ${userSet.size} (chain,user,block) positions\n`,
  )

  const bcalls = new Map<ChainKey, SubCall[]>()
  for (const c of chains) bcalls.set(c, blockCalls(setups.get(c)!))
  const prog = progress('aave-events fetch')
  const total = blockSet.size + userSet.size
  let done = 0
  await kc.fetchAll(
    [...blockSet].map(([key, v]) => ({
      key,
      chain: v.chain,
      to: MULTICALL3,
      data: encMulticall(bcalls.get(v.chain)!),
      block: v.b,
    })),
    10,
    () => prog(++done, total),
  )
  await kc.fetchAll(
    [...userSet].map(([key, v]) => ({
      key,
      chain: v.chain,
      to: MULTICALL3,
      data: encMulticall(userCalls(setups.get(v.chain)!, v.user)),
      block: v.b,
    })),
    10,
    () => prog(++done, total),
  )

  const blockState = (chain: ChainKey, b: number): BlockState => {
    const setup = setups.get(chain)!
    const s = kc.get(bKey(chain, b))!
    if (s.ans.revert) throw new Error(`block multicall reverted ${chain} ${b}`)
    const res = decMulticall(bcalls.get(chain)!, s.ans.result as Hex)
    let per: SubResult[] | undefined
    if (!res[0].ok) {
      const ps = kc.get(pKey(chain, b))
      if (ps && !ps.ans.revert) per = decMulticall(perAssetPriceCalls(setup), ps.ans.result as Hex)
    }
    return decodeBlock(setup, bcalls.get(chain)!, res, per)
  }
  // Blocks whose batch price call failed: read per-asset prices.
  const needPer = [...blockSet].filter(([key, v]) => {
    const s = kc.get(key)!
    if (s.ans.revert) return false
    return !decMulticall(bcalls.get(v.chain)!, s.ans.result as Hex)[0].ok
  })
  if (needPer.length) {
    process.stderr.write(`[aave-events] ${needPer.length} blocks need per-asset prices\n`)
    await kc.fetchAll(
      needPer.map(([, v]) => ({
        key: pKey(v.chain, v.b),
        chain: v.chain,
        to: MULTICALL3,
        data: encMulticall(perAssetPriceCalls(setups.get(v.chain)!)),
        block: v.b,
      })),
    )
  }

  const userState = (chain: ChainKey, user: string, b: number) =>
    decodeUser(
      setups.get(chain)!,
      decMulticall(
        userCalls(setups.get(chain)!, user),
        kc.get(uKey(chain, user, b))!.ans.result as Hex,
      ),
    )

  const evaluate = (r: AaveEventRow) => {
    const setup = setups.get(r.chain)!
    const P = r.block_number - 1
    const u = userState(r.chain, r.user, P)
    const bp = blockState(r.chain, P)
    const bn = blockState(r.chain, r.block_number)
    const prev = computeHf(setup, u, bp, bp.prices)
    const atN = computeHf(setup, { ...u }, bp, bn.prices)
    return { setup, P, u, bp, bn, prev, atN }
  }

  // Verification: sample + anomalies. Anomalies: any HF recompute mismatch, any missing / zero
  // price on a held reserve, any failed sub-call, a >20% price move N-1 -> N on a held reserve.
  for (let round = 0; round < 3; round++) {
    const anomalous = new Set<string>()
    for (const r of rows) {
      const P = r.block_number - 1
      let ev: ReturnType<typeof evaluate> | null = null
      try {
        ev = evaluate(r)
      } catch {
        anomalous.add(uKey(r.chain, r.user, P))
        anomalous.add(bKey(r.chain, P))
        anomalous.add(bKey(r.chain, r.block_number))
        continue
      }
      const { u, bp, bn, prev, setup } = ev
      if (prev.healthFactor !== u.account.healthFactor || prev.missingPrice.length) {
        anomalous.add(uKey(r.chain, r.user, P))
        anomalous.add(bKey(r.chain, P))
      }
      setup.assets.forEach((_, k) => {
        const id = BigInt(setup.assets[k].id)
        if (!(((u.userConfig >> (2n * id)) & 3n) !== 0n)) return
        const a = bp.prices[k]
        const z = bn.prices[k]
        if (!a || !z) {
          anomalous.add(bKey(r.chain, P))
          anomalous.add(bKey(r.chain, r.block_number))
        } else if (Math.abs(Number(z - a)) / Number(a) > 0.2) {
          anomalous.add(bKey(r.chain, P))
          anomalous.add(bKey(r.chain, r.block_number))
        }
      })
    }
    const keys = [...blockSet.keys(), ...userSet.keys()]
    const changed = await kc.verifyAll(keys, anomalous)
    process.stderr.write(
      `[aave-events] verify round ${round}: ${anomalous.size} anomalous keys, ${changed.length} changed\n`,
    )
    const req = await kc.requeryTainted([...keys, ...needPer.map(([, v]) => pKey(v.chain, v.b))])
    if (!changed.length && !req.length) break
  }
  const pxKeys = needPer.map(([, v]) => pKey(v.chain, v.b))
  if (pxKeys.length) await kc.verifyAll(pxKeys, new Set(pxKeys))

  // Output
  const lines: string[] = []
  const stats = {
    events: rows.length,
    hfExact: 0,
    hfWithin1e6: 0,
    hfMismatch: 0,
    csvWithin1e6: 0,
    csvCompared: 0,
    totalsExact: 0,
    liquidatableAtN: 0,
    notLiquidatableAtN: 0,
    missingPrice: 0,
    errors: 0,
    byChain: {} as Record<string, Record<string, number>>,
  }
  const mism: unknown[] = []
  for (const r of rows) {
    const bc = (stats.byChain[r.chain] ??= {
      events: 0,
      hfExact: 0,
      hfWithin1e6: 0,
      liquidatableAtN: 0,
      notLiquidatableAtN: 0,
      missingPrice: 0,
    })
    bc.events++
    let ev: ReturnType<typeof evaluate>
    try {
      ev = evaluate(r)
    } catch (e) {
      stats.errors++
      lines.push(
        JSON.stringify({
          chain: r.chain,
          block_number: r.block_number,
          log_index: r.log_index,
          tx_hash: r.tx_hash,
          user: r.user,
          error: String((e as Error).message),
        }),
      )
      continue
    }
    const { setup, P, u, bp, bn, prev, atN } = ev
    const hfOn = u.account.healthFactor
    const rd = relDiff(prev.healthFactor, hfOn)
    if (prev.healthFactor === hfOn) {
      stats.hfExact++
      bc.hfExact++
    }
    if (rd <= 1e-6) {
      stats.hfWithin1e6++
      bc.hfWithin1e6++
    } else {
      stats.hfMismatch++
      if (mism.length < 30)
        mism.push({
          chain: r.chain,
          block: P,
          user: r.user,
          onchain: hfOn.toString(),
          recomputed: prev.healthFactor.toString(),
          rd,
        })
    }
    if (
      prev.totalCollateralBase === u.account.totalCollateralBase &&
      prev.totalDebtBase === u.account.totalDebtBase &&
      prev.avgLT === u.account.currentLiquidationThreshold
    )
      stats.totalsExact++
    const csvHf = Number(r.health_factor)
    let csvRd: number | null = null
    if (Number.isFinite(csvHf) && csvHf > 0) {
      stats.csvCompared++
      csvRd = Math.abs(Number(hfOn) / 1e18 - csvHf) / csvHf
      if (csvRd <= 1e-6) stats.csvWithin1e6++
    }
    const liq = atN.missingPrice.length === 0 && atN.healthFactor < WAD
    if (atN.missingPrice.length || prev.missingPrice.length) {
      stats.missingPrice++
      bc.missingPrice++
    } else if (liq) {
      stats.liquidatableAtN++
      bc.liquidatableAtN++
    } else {
      stats.notLiquidatableAtN++
      bc.notLiquidatableAtN++
    }
    const em = u.eMode ? bp.emode.get(u.eMode) : undefined
    const position = setup.assets
      .map((a, k) => {
        const id = BigInt(a.id)
        const ur = u.reserves[k]
        const flags = (u.userConfig >> (2n * id)) & 3n
        if (!flags && !ur.aToken && !ur.variableDebt && !ur.stableDebt) return null
        const cfg = bp.config[k]
        const inEm = !!em && ((em.bitmap >> id) & 1n) === 1n
        return {
          asset: a.address,
          symbol: a.symbol,
          id: a.id,
          decimals: decimalsOf(cfg),
          aTokenBalance: ur.aToken.toString(),
          variableDebt: ur.variableDebt.toString(),
          stableDebt: ur.stableDebt.toString(),
          usageAsCollateralEnabled: ur.usageAsCollateralEnabled,
          collateralFlag: (flags & 2n) === 2n,
          borrowingFlag: (flags & 1n) === 1n,
          ltv: Number(ltvOf(cfg)),
          lt: Number(ltOf(cfg)),
          eModeLt: inEm ? Number(em!.lt) : null,
          ltUsed: Number(inEm && ltOf(cfg) !== 0n ? em!.lt : ltOf(cfg)),
          priceNm1: bp.prices[k]?.toString() ?? null,
          priceN: bn.prices[k]?.toString() ?? null,
          priceErrNm1: bp.priceErr[k],
          priceErrN: bn.priceErr[k],
        }
      })
      .filter(Boolean)
    const uRow = kc.store.get(uKey(r.chain, r.user, P))!
    lines.push(
      JSON.stringify({
        chain: r.chain,
        block_number: r.block_number,
        log_index: r.log_index,
        tx_hash: r.tx_hash,
        user: r.user,
        ts: r.ts,
        collateral_asset: r.collateral_asset,
        debt_asset: r.debt_asset,
        blockRead: P,
        eMode: u.eMode,
        userConfig: '0x' + u.userConfig.toString(16),
        position,
        accountDataNm1: Object.fromEntries(
          Object.entries(u.account).map(([k, v]) => [k, v.toString()]),
        ),
        recomputedNm1: {
          totalCollateralBase: prev.totalCollateralBase.toString(),
          totalDebtBase: prev.totalDebtBase.toString(),
          avgLT: prev.avgLT.toString(),
          healthFactor: prev.healthFactor.toString(),
        },
        hfMatch: { exact: prev.healthFactor === hfOn, relDiff: rd, csvRelDiff: csvRd },
        atN: {
          totalCollateralBase: atN.totalCollateralBase.toString(),
          totalDebtBase: atN.totalDebtBase.toString(),
          avgLT: atN.avgLT.toString(),
          healthFactor: atN.healthFactor.toString(),
          hf: Number(atN.healthFactor) / 1e18,
          liquidatable: liq,
          missingPrice: atN.missingPrice,
        },
        hfNm1: Number(hfOn) / 1e18,
        hosts: {
          position: uRow.host,
          stateNm1: kc.store.get(bKey(r.chain, P))!.host,
          stateN: kc.store.get(bKey(r.chain, r.block_number))!.host,
        },
      }),
    )
  }
  writeFileSync(join(ctx.outDir, 'aave-events.jsonl.gz'), gzipSync(lines.join('\n') + '\n'))
  const summary = {
    ...stats,
    mismatchExamples: mism,
    verification: ctx.verifier.stats(OUT),
    calls: kc.store.size,
  }
  process.stderr.write(`[aave-events] ${JSON.stringify({ ...stats, byChain: undefined })}\n`)
  return summary
}

export { computeHf }
