// build-llama-pools.mjs — which DefiLlama yields pool is which lending market, for the
// /position lending block's 30-day history on Aave V3, Spark and Compound V3.
//
// DefiLlama's free yields API serves one pool's daily history at /chart/{pool}: tvlUsd (for
// a lending pool, its supply minus its borrow: the liquidity a lender can withdraw) and
// apyBase / apyReward. The pool ids come from /pools, an 11 MB list too large to fetch in
// a browser, so the mainnet core-market pools are kept here: one per (project, underlying
// token), poolMeta null only (DefiLlama's other Aave instances — Prime, Horizon — and
// Compound's collateral pools carry a poolMeta and are different markets).
//
// Only ids and labels are kept: no number from /pools enters the page.
//
// Run:  node scripts/position/build-llama-pools.mjs

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const URL_POOLS = 'https://yields.llama.fi/pools'
const PROJECTS = { 'aave-v3': 'aave-v3', sparklend: 'spark', 'compound-v3': 'compound-v3' }

const res = await fetch(URL_POOLS)
if (!res.ok) throw new Error(`${URL_POOLS}: HTTP ${res.status}`)
const { data } = await res.json()
// Two core pools on one underlying (aave-v3 GHO and sGHO) cannot be told apart by token:
// both are left out and listed, so the page says "not matched" rather than guess.
const byKey = new Map()
for (const p of data) {
  if (p.chain !== 'Ethereum' || !(p.project in PROJECTS) || p.poolMeta) continue
  const u = (p.underlyingTokens ?? []).map((x) => String(x).toLowerCase())
  if (u.length !== 1) continue
  const key = `${PROJECTS[p.project]}:${u[0]}`
  byKey.set(key, [...(byKey.get(key) ?? []), { protocol: PROJECTS[p.project], underlying: u[0], symbol: p.symbol, pool: p.pool }])
}
const pools = [...byKey.values()].filter((xs) => xs.length === 1).map((xs) => xs[0])
const ambiguous = [...byKey.entries()].filter(([, xs]) => xs.length > 1).map(([key, xs]) => ({ key, symbols: xs.map((x) => x.symbol) }))
pools.sort((a, b) => a.protocol.localeCompare(b.protocol) || a.symbol.localeCompare(b.symbol))
const out = { schema: 1, source: { url: URL_POOLS, fetchedAt: new Date().toISOString() }, ambiguous, pools }
const file = join(dirname(fileURLToPath(import.meta.url)), '../../lib/position/llamaPools.generated.json')
writeFileSync(file, JSON.stringify(out, null, 1) + '\n')
console.log(`wrote ${pools.length} pools to ${file}`)
