/**
 * Writes tests/unit/fixtures/wavefront-census-fixture.json: a small, committed subset of the
 * on-chain pull — 20 positions picked to cover every branch the census takes (mixed splits, a
 * half that opens under its line, no-delay by symbol and by line, sold at t0, cured, sold at
 * the grid end, the shifted t0, not located / not liquidatable, Morpho with an unpriced loan,
 * a loan priced through the Aave path, realised bad debt) — so tests/unit/wavefrontCensus.test.ts
 * can run the census without the datasets repo.
 *
 * Oracle columns are cut to what the subset reads (nothing before the earliest first event of
 * a position that reads the column — the walk only reads minutes after t0 and the real side
 * only the event minute) and run-length encoded as [value, count] pairs. `expected` holds the
 * FULL census's figures for each position; positions are independent, so the subset must
 * reproduce them exactly.
 *
 *   MEMBRANE_DATASETS_DIR=... npx tsx scripts/oct10-coverage/make-census-fixture.ts
 * (run build-census.ts first: `expected` is read from its census.json).
 */
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

import { datasetsDir } from '../lib/datasetsDir.mjs'
import { aaveEvents as readAaveCsv, morphoEvents as readMorphoCsv } from './inputs'

export const FIXTURE_PIDS = [
  'aave-v3:mainnet:0x1326f7c79c13f6a4fa8e44b2e896e500a5b1b92a', // not located
  'aave-v3:mainnet:0xe54dae18b3af0a840c72cc8c0a0c2200acbf6ade', // mixed, both halves sizeable
  'aave-v3:mainnet:0xc4cde783db4c4f02da75121cdcefbe286a961071', // mixed, a half opens under its line
  'aave-v3:mainnet:0x5f8b00a18111bacced63065cdce2b8dba073b074', // no-delay by line (> 90%)
  'aave-v3:mainnet:0xb2633e23645fcf4857567c90e96f82e1c7ba6725', // no-delay, stable collateral
  'aave-v3:mainnet:0x2500541a5cc23ee69e4b3018cfd389d530f4f546', // sold at t0 past the band
  'aave-v3:mainnet:0xbf3401cee68f45d1963407076c119f1b3867bee8', // cured then held ($23M debt)
  'aave-v3:mainnet:0x5834b58314dc8052ffd0e9a14f3596a4baf463a1', // sold at the grid end
  'aave-v3:mainnet:0xed91091c64dd7cafea840544c008467309840634', // sold at the band, 3 legs
  'aave-v3:optimism:0xcb928017e3695d0ae6f2f2b8e494eb1842df350c', // t0 shifted to event 2
  'aave-v3:base:0xab35e823b33a1bfa47a1e5e5690b9f6e921393e6', // late, sold at the grid end
  'aave-v3:base:0xda9e811371f54d400ab973db4cd2392ccb55e3dc', // late, sold at t0
  'morpho-blue:base:0x5b347b3dcfed096f09040cd30a174ae354ecc0a35c996493b8fa490d6d3e79d7:0xceb9f5d4b085f601fef28497f6b5c42fdcb5e599', // not liquidatable at N
  'morpho-blue:mainnet:0xc7d717f4052ac4e5463dcc58cea0f6b05dd7d8c67e0aee68ebe30a8af09b259f:0x01cdb251aebdfaf8ae1b1d1a0d8274f3c99823d2', // bad debt
  'morpho-blue:mainnet:0x5ffdf15c5a4d7c6affb3f12634eeda1a20e60b92c0eb547f61754f656b55841e:0x6fef131d0014d0724439a77553c2fe89d0ff9caf', // bad debt, sold at t0
  'morpho-blue:mainnet:0x3f1d5c88c72432b04f2074499fe217468af49ddaa98bcb6ec80b08f76a82c6ec:0x130052fb52054ce9b57f46b2bb47cecc28f3004f', // Mog
  'morpho-blue:mainnet:0xf233b01465a6bf75ea9d89eaac87b7207753fdb1ec021138bdf02b7dcd504361:0x31af52540aaf41de1c18bfaad696c1ca2232d013', // unpriced loan (USDf), no-delay by LLTV
  'morpho-blue:mainnet:0xff527fe9c6516f9d82a3d51422ccb031d123266e6e26d4c22c942a948c180a75:0x06812eef8fe9999aeccb0fae56bb98626cbf8a91', // EURC loan priced via the Aave path
  'morpho-blue:mainnet:0x8aa8614fca17b7efd787e3677bab78fce4a4928866375e86275001515b1f8114:0x1eb322c016815ee5b29c071586c1b75be5934576', // WETH loan via the Aave path, no-delay by LLTV
  'morpho-blue:mainnet:0xdc5333039bcf15f1237133f74d5806675d83d9cf19cfd4cfdd9be674842651bf:0x1fa909909d5501d66f7e20b3f9d0cc5c598f020a', // no-delay by LLTV, USDT loan
]

/** Run-length encode a column: [[value, count], …]. */
export function rle<T>(xs: readonly T[]): [T, number][] {
  const out: [T, number][] = []
  for (const x of xs) {
    const last = out[out.length - 1]
    if (last && last[0] === x) last[1]++
    else out.push([x, 1])
  }
  return out
}
export function unrle<T>(xs: readonly [T, number][]): T[] {
  const out: T[] = []
  for (const [v, n] of xs) for (let i = 0; i < n; i++) out.push(v)
  return out
}

if (process.argv[1] && process.argv[1].endsWith('make-census-fixture.ts')) {
  const D = datasetsDir(process.cwd())
  const INPUTS = path.join(D, 'recall-coverage', 'inputs', 'oct10')
  const ON = path.join(INPUTS, 'onchain')
  const gz = (p: string) => JSON.parse(gunzipSync(fs.readFileSync(p)).toString())
  const gzLines = (p: string) =>
    gunzipSync(fs.readFileSync(p))
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  const pids = new Set(FIXTURE_PIDS)
  const aPid = (chain: string, user: string) => `aave-v3:${chain}:${user.toLowerCase()}`
  const mPid = (chain: string, m: string, b: string) =>
    `morpho-blue:${chain}:${m.toLowerCase()}:${b.toLowerCase()}`

  // Only the fields the census reads (lib/wavefront/aave.ts, morpho.ts, census.ts).
  const pick = (o: any, keys: readonly string[]): any =>
    Object.fromEntries(keys.map((k) => [k, o[k]]))
  const CSV_COMMON = ['chain', 'block_number', 'ts', 'tx_hash', 'log_index']
  const aaveCsv = (readAaveCsv(INPUTS) as any[])
    .filter((r) => pids.has(aPid(r.chain, r.user)))
    .map((r) =>
      pick(r, [
        ...CSV_COMMON,
        'user',
        'collateral_asset',
        'debt_asset',
        'collateral_symbol',
        'debt_symbol',
        'debt_to_cover_normalized',
        'liquidated_collateral_normalized',
      ]),
    )
  const RESERVE = [
    'asset',
    'symbol',
    'decimals',
    'aTokenBalance',
    'variableDebt',
    'stableDebt',
    'collateralFlag',
    'ltUsed',
    'priceNm1',
    'priceN',
  ]
  const aaveEvents = (gzLines(path.join(ON, 'aave-events.jsonl.gz')) as any[])
    .filter((e) => pids.has(aPid(e.chain, e.user)))
    .map((e) => ({
      ...pick(e, [
        ...CSV_COMMON.filter((k) => k !== 'ts'),
        'ts',
        'user',
        'collateral_asset',
        'debt_asset',
        'eMode',
      ]),
      position: e.position.map((r: any) => pick(r, RESERVE)),
      atN: pick(e.atN, ['hf', 'liquidatable']),
    }))
  const morphoCsv = (readMorphoCsv(INPUTS) as any[])
    .filter((r) => pids.has(mPid(r.chain, r.market_id, r.borrower)))
    .map((r) =>
      pick(r, [
        ...CSV_COMMON,
        'market_id',
        'borrower',
        'repaid_assets_normalized',
        'seized_assets',
        'bad_debt_assets_normalized',
        'collateral_symbol',
        'loan_symbol',
      ]),
    )
  const morphoEvents = (gzLines(path.join(ON, 'morpho-events.jsonl.gz')) as any[])
    .filter((e) => pids.has(mPid(e.chain, e.market_id, e.borrower)))
    .map((e) =>
      pick(e, [
        ...CSV_COMMON,
        'borrower',
        'market_id',
        'oracle',
        'loanToken',
        'collateralToken',
        'loanDecimals',
        'collateralDecimals',
        'lltv',
        'positionNm1',
        'priceN',
        'borrowedNAccrued',
        'ltvN',
        'liquidatableN',
      ]),
    )
  const START = 1760054400
  const minuteOf = (ts: number) => Math.floor((ts - START) / 60)

  // Earliest minute each column is read from: the first event of any position that reads it.
  const need = new Map<string, number>() // `${proto}|${chain}|${key}` -> first minute
  const want = (k: string, m: number) => need.set(k, Math.min(need.get(k) ?? Infinity, m))
  const firstMinute = new Map<string, number>()
  for (const e of aaveEvents) {
    const p = aPid(e.chain, e.user)
    firstMinute.set(p, Math.min(firstMinute.get(p) ?? Infinity, minuteOf(e.ts)))
  }
  for (const e of morphoEvents) {
    const p = mPid(e.chain, e.market_id, e.borrower)
    firstMinute.set(p, Math.min(firstMinute.get(p) ?? Infinity, minuteOf(e.ts)))
  }
  for (const e of aaveEvents) {
    const m = firstMinute.get(aPid(e.chain, e.user))!
    for (const r of e.position) want(`aave|${e.chain}|${r.asset}`, m)
  }
  for (const e of morphoEvents) {
    const m = firstMinute.get(mPid(e.chain, e.market_id, e.borrower))!
    want(`morpho|${e.chain}|${e.oracle}`, m)
    want(`aave|${e.chain}|${e.loanToken.toLowerCase()}`, m) // loan USD through the Aave path
  }

  const aaveOracle: Record<string, any> = {}
  for (const c of ['mainnet', 'arbitrum', 'optimism', 'base']) {
    const f = gz(path.join(ON, `aave-oracle-1m.${c}.json.gz`))
    const prices: Record<string, [string | null, number][]> = {}
    for (const [k, m] of need) {
      const [proto, chain, key] = k.split('|')
      if (proto !== 'aave' || chain !== c || !f.prices[key]) continue
      prices[key] = rle(f.prices[key].map((v: string | null, i: number) => (i < m ? null : v)))
    }
    if (Object.keys(prices).length) {
      aaveOracle[c] = {
        chain: c,
        baseUnit: f.baseUnit,
        startTs: f.startTs,
        stepSeconds: f.stepSeconds,
        count: f.count,
        assets: f.assets.filter((a: any) => prices[a.address]),
        prices,
      }
    }
  }
  const morphoOracle: Record<string, any> = {}
  for (const c of ['mainnet', 'base']) {
    const f = gz(path.join(ON, `morpho-oracle-1m.${c}.json.gz`))
    const prices: Record<string, [string | null, number][]> = {}
    for (const [k, m] of need) {
      const [proto, chain, key] = k.split('|')
      if (proto !== 'morpho' || chain !== c) continue
      prices[key] = rle(f.prices[key].map((v: string | null, i: number) => (i < m ? null : v)))
    }
    if (Object.keys(prices).length) morphoOracle[c] = { chain: c, prices }
  }

  const census = JSON.parse(
    fs.readFileSync(path.join(D, 'oct10-2025', 'coverage', 'census.json'), 'utf8'),
  )
  const expected = Object.fromEntries(
    census.rows
      .filter((r: any) => pids.has(r.pid))
      .map((r: any) => [
        r.pid,
        {
          walked: r.walked,
          delayClass: r.delayClass,
          line: r.line,
          ltv0: r.ltv0,
          realRepaidUsd: r.real.repaidUsd,
          realSeizedUsd: r.real.seizedUsd,
          realBadDebtUsd: r.real.badDebtUsd,
          memRepaidUsd: r.mem?.repaidUsd ?? null,
          memClosedT0: r.mem?.closedT0 ?? null,
          memOutcome: r.mem?.outcome ?? null,
          memSales: r.mem?.sales ?? null,
        },
      ]),
  )
  if (Object.keys(expected).length !== pids.size)
    throw new Error('fixture: a pid is not in census.json')

  const out = {
    note: 'Generated by scripts/oct10-coverage/make-census-fixture.ts from the Oct 10-11 on-chain pull. Oracle columns are [value, count] runs, null before the earliest minute the subset reads.',
    window: { startTs: START, stepSeconds: 60, minutes: 2880 },
    pids: FIXTURE_PIDS,
    aaveCsv,
    aaveEvents,
    aaveOracle,
    morphoCsv,
    morphoEvents,
    morphoOracle,
    expected,
  }
  const p = path.join(process.cwd(), 'tests', 'unit', 'fixtures', 'wavefront-census-fixture.json')
  fs.writeFileSync(p, JSON.stringify(out) + '\n')
  console.log(`wrote ${p} (${fs.statSync(p).size} B)`)
}
