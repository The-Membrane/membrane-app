#!/usr/bin/env node
// Verify every entry of data/oracle-registry/catalog.json ON-CHAIN (Ethereum mainnet).
//
//   node scripts/oracle-registry/verify-catalog.mjs            # print the table
//   node scripts/oracle-registry/verify-catalog.mjs --write    # also stamp status into catalog.json
//                                                              # and write verification-latest.json
//   node scripts/oracle-registry/verify-catalog.mjs --only=weeth  # entries whose id contains "weeth"
//   node scripts/oracle-registry/verify-catalog.mjs --catalog=/tmp/x.json  # verify another copy
//
// Per entry it checks: bytecode exists; the read method returns; decimals / description /
// wat() match the catalog; the decoded price sits in the asset's sanity range for its quote
// unit; every `usedBy[].check` holds (Aave/Spark getSourceOfAsset, Morpho idToMarketParams,
// Liquity AddressesRegistry.priceFeed); every component getter returns the catalogued
// address; Uniswap pools match factory.getPool and token order. Staleness and governance
// parameter drift are WARNINGS (the address is still right); everything else is a FAILURE
// that marks the entry `unverified` with the reason.
//
// RPC: RECORDER_RPC_URL from .env.local via scripts/lib/venue-reads.mjs. URLs are never
// printed — error text is scrubbed of anything that looks like a URL.

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getAddress, isAddressEqual, parseAbi } from 'viem'
import { ROOT, readEnv, makeClient } from '../lib/venue-reads.mjs'
import { guardProcessErrors } from './lib/readers.mjs'

// An RPC failure escaping a top-level await prints scrubbed, never the (keyed) URL.
guardProcessErrors('oracle-registry verify')

const args = process.argv.slice(2)
const argVal = (k) => (args.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3)
// --catalog=<path> verifies another copy (used by the negative self-test); default is the real catalog.
const CATALOG = argVal('catalog') || join(ROOT, 'data', 'oracle-registry', 'catalog.json')
const LATEST = join(ROOT, 'data', 'oracle-registry', 'verification-latest.json')
const WRITE = args.includes('--write')
const ONLY = argVal('only').toLowerCase()
const CONCURRENCY = 4
const PROBE_CALLER = '0x000000000000000000000000000000000000dEaD'

const scrub = (msg) =>
  String(msg ?? '')
    .replace(/https?:\/\/\S+/g, '[rpc]')
    .split('\n')[0]
    .slice(0, 160)

const rpc = readEnv().get('RECORDER_RPC_URL')
if (!rpc) {
  console.error('RECORDER_RPC_URL missing from .env.local')
  process.exit(1)
}
const client = makeClient(rpc)

// ---- low-level read helpers -------------------------------------------------
const abiCache = new Map()
function fn(sig) {
  if (!abiCache.has(sig)) abiCache.set(sig, parseAbi([sig]))
  return abiCache.get(sig)
}
let BLOCK
async function call(address, sig, callArgs = [], opts = {}) {
  const abi = fn(sig)
  const name = abi[0].name
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const value = await client.readContract({
        address,
        abi,
        functionName: name,
        args: callArgs,
        blockNumber: BLOCK,
        ...opts,
      })
      return { ok: true, value }
    } catch (e) {
      const reverted = /revert|execution reverted|returned no data/i.test(
        e?.shortMessage || e?.message || '',
      )
      if (reverted || attempt === 1)
        return { ok: false, error: scrub(e?.shortMessage || e?.message) }
      await new Promise((r) => setTimeout(r, 400))
    }
  }
  return { ok: false, error: 'unreachable' }
}
const toNum = (v, decimals) => Number(v) / 10 ** decimals
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, '')
const graceFor = (hb) => Math.max(600, Math.round(hb * 0.1))

// ---- price readers, keyed by readMethod ---------------------------------------
async function readPrice(e, ctx) {
  const addr = e.address
  switch (e.readMethod) {
    case 'latestRoundData()': {
      const r = await call(
        addr,
        'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
      )
      if (!r.ok) return r
      return { ok: true, price: toNum(r.value[1], e.decimals), updatedAt: Number(r.value[3]) }
    }
    case 'latestAnswer()': {
      const r = await call(addr, 'function latestAnswer() view returns (int256)')
      if (!r.ok) return r
      return { ok: true, price: toNum(r.value, e.decimals), updatedAt: null }
    }
    case 'readWithAge()': {
      const r = await call(addr, 'function readWithAge() view returns (uint256,uint256)')
      if (!r.ok) return r
      // Chronicle reads are tolled; record whether a non-whitelisted caller can read too.
      const probe = await call(addr, 'function read() view returns (uint256)', [], {
        account: PROBE_CALLER,
      })
      ctx.notes.push(probe.ok ? 'read: open' : 'read: tolled (address(0) eth_call only)')
      ctx.access = probe.ok ? 'open' : 'zero_address_only'
      return { ok: true, price: toNum(r.value[0], e.decimals), updatedAt: Number(r.value[1]) }
    }
    case 'price()': {
      const r = await call(addr, 'function price() view returns (uint256)')
      if (!r.ok) return r
      return { ok: true, price: toNum(r.value, e.decimals), updatedAt: null }
    }
    case 'lastGoodPrice()': {
      const r = await call(addr, 'function lastGoodPrice() view returns (uint256)')
      if (!r.ok) return r
      // fetchPrice() is state-changing but harmless under eth_call: it shows the live price
      // the next branch operation would use.
      const live = await call(addr, 'function fetchPrice() view returns (uint256,bool)')
      if (live.ok) {
        ctx.livePrice = toNum(live.value[0], 18)
        ctx.notes.push(
          `fetchPrice() live ${fmt(ctx.livePrice)}${live.value[1] ? ' (oracle failure!)' : ''}`,
        )
      }
      return { ok: true, price: toNum(r.value, e.decimals), updatedAt: null }
    }
    case 'getPriceUnsafe(bytes32)': {
      const r = await call(
        addr,
        'function getPriceUnsafe(bytes32) view returns ((int64 price,uint64 conf,int32 expo,uint256 publishTime))',
        [e.readArgs[0]],
      )
      if (!r.ok) return r
      const { price, conf, expo, publishTime } = r.value
      if (-expo !== e.decimals) ctx.warnings.push(`expo ${expo} ≠ -decimals`)
      ctx.notes.push(`conf ±${fmt(Number(conf) * 10 ** expo)}`)
      return { ok: true, price: Number(price) * 10 ** expo, updatedAt: Number(publishTime) }
    }
    case 'observe(uint32[])': {
      const t = e.mechanism.twap
      const window = Number(e.readArgs[0])
      const r = await call(addr, 'function observe(uint32[]) view returns (int56[],uint160[])', [
        [window, 0],
      ])
      if (!r.ok) return r
      const [c0, c1] = r.value[0]
      const delta = c1 - c0
      let tick = Number(delta / BigInt(window))
      if (delta < 0n && delta % BigInt(window) !== 0n) tick -= 1 // round toward −∞ like OracleLibrary
      const t0 = await call(addr, 'function token0() view returns (address)')
      if (!t0.ok) return t0
      const baseIs0 = isAddressEqual(t0.value, t.baseToken)
      const dec0 = baseIs0 ? t.baseDecimals : t.quoteDecimals
      const dec1 = baseIs0 ? t.quoteDecimals : t.baseDecimals
      const p1per0 = Math.pow(1.0001, tick) * 10 ** (dec0 - dec1)
      return { ok: true, price: baseIs0 ? p1per0 : 1 / p1per0, updatedAt: null, tick }
    }
    case 'getPtToAssetRate(address,uint32)': {
      const [market, win] = e.readArgs
      const r = await call(
        addr,
        'function getPtToAssetRate(address,uint32) view returns (uint256)',
        [getAddress(market), Number(win)],
      )
      if (!r.ok) return r
      const st = await call(
        addr,
        'function getOracleState(address,uint32) view returns (bool,uint16,bool)',
        [getAddress(market), Number(win)],
      )
      if (st.ok && (st.value[0] || !st.value[2]))
        ctx.warnings.push('TWAP window not satisfied (getOracleState)')
      return { ok: true, price: toNum(r.value, e.decimals), updatedAt: null }
    }
    default:
      return { ok: false, error: `no reader for readMethod ${e.readMethod}` }
  }
}

// ---- identity / wiring checks ---------------------------------------------------
async function checkIdentity(e, ctx) {
  if (e.readMethod === 'latestRoundData()' || e.readMethod === 'latestAnswer()') {
    const d = await call(e.address, 'function decimals() view returns (uint8)')
    if (d.ok && Number(d.value) !== e.decimals)
      ctx.failures.push(`decimals() ${d.value} ≠ catalog ${e.decimals}`)
  }
  if (e.expect?.description) {
    const d = await call(e.address, 'function description() view returns (string)')
    if (!d.ok) ctx.failures.push(`description() failed: ${d.error}`)
    else if (norm(d.value) !== norm(e.expect.description))
      ctx.failures.push(`description "${d.value}" ≠ expected "${e.expect.description}"`)
  }
  if (e.expect?.wat) {
    const w = await call(e.address, 'function wat() view returns (bytes32)')
    const wat = w.ok
      ? Buffer.from(w.value.slice(2), 'hex').toString('utf8').replace(/\0/g, '')
      : null
    if (wat !== e.expect.wat) ctx.failures.push(`wat() "${wat}" ≠ expected "${e.expect.wat}"`)
  }
  if (e.mechanism?.twap) {
    const t = e.mechanism.twap
    const p = await call(
      t.factory,
      'function getPool(address,address,uint24) view returns (address)',
      [t.baseToken, t.quoteToken, t.fee],
    )
    if (!p.ok || !isAddressEqual(p.value, e.address))
      ctx.failures.push(`factory.getPool ≠ catalog pool (${p.ok ? p.value : p.error})`)
  }
}

async function checkUsedBy(e, ctx, asset, price) {
  for (const u of e.usedBy || []) {
    const c = u.check
    if (!c) continue
    if (c.type === 'aave_source') {
      const s = await call(c.oracle, 'function getSourceOfAsset(address) view returns (address)', [
        c.asset,
      ])
      if (!s.ok || !isAddressEqual(s.value, e.address)) {
        ctx.failures.push(
          `${u.protocol} ${u.market}: getSourceOfAsset = ${s.ok ? s.value : s.error}`,
        )
        continue
      }
      const px = await call(c.oracle, 'function getAssetPrice(address) view returns (uint256)', [
        c.asset,
      ])
      if (px.ok && price != null && e.quoteUnit === 'USD') {
        const marketPx = toNum(px.value, 8)
        if (Math.abs(marketPx - price) / price > 1e-6)
          ctx.failures.push(`${u.market}: getAssetPrice ${fmt(marketPx)} ≠ feed ${fmt(price)}`)
      }
      ctx.checks++
    } else if (c.type === 'morpho_market') {
      const m = await call(
        c.morpho,
        'function idToMarketParams(bytes32) view returns (address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)',
        [c.marketId],
      )
      if (!m.ok) {
        ctx.failures.push(`Morpho market ${c.marketId.slice(0, 10)}…: ${m.error}`)
        continue
      }
      const [, collateral, oracle] = m.value
      if (!isAddressEqual(oracle, e.address))
        ctx.failures.push(`Morpho market ${c.marketId.slice(0, 10)}… oracle = ${oracle}`)
      else if (asset.token && !isAddressEqual(collateral, asset.token))
        ctx.failures.push(`Morpho market ${c.marketId.slice(0, 10)}… collateral = ${collateral}`)
      else ctx.checks++
    } else if (c.type === 'liquity_registry') {
      const pf = await call(c.registry, 'function priceFeed() view returns (address)')
      const ct = await call(c.registry, 'function collToken() view returns (address)')
      if (!pf.ok || !isAddressEqual(pf.value, e.address))
        ctx.failures.push(`Liquity registry priceFeed = ${pf.ok ? pf.value : pf.error}`)
      else if (!ct.ok || !asset.token || !isAddressEqual(ct.value, asset.token))
        ctx.failures.push(`Liquity registry collToken = ${ct.ok ? ct.value : ct.error}`)
      else ctx.checks++
    } else {
      ctx.failures.push(`unknown usedBy check ${c.type}`)
    }
  }
}

async function checkComponents(e, ctx, byId) {
  const comps = e.mechanism?.components || []
  for (const comp of comps) {
    // A `ref` names the catalog entry AT this address (its verdict ages the view): offline check.
    if (comp.ref) {
      const ref = byId.get(comp.ref)
      if (!ref || !isAddressEqual(ref.address, comp.address))
        ctx.failures.push(
          `component ${comp.role}: ref ${comp.ref} is not the entry at ${comp.address}`,
        )
      else ctx.checks++
    }
    if (!comp.getter) continue
    const name = comp.getter.replace(/\(\)$/, '')
    const sig =
      comp.getterKind === 'struct0'
        ? `function ${name}() view returns (address,uint256,uint8)`
        : `function ${name}() view returns (address)`
    // A nested leg (`via`) is returned by its parent component's getter, not the entry's.
    const on = comp.via ? comps.find((p) => p.role === comp.via)?.address : e.address
    if (!on) {
      ctx.failures.push(`component ${comp.role}: via ${comp.via} names no component`)
      continue
    }
    const r = await call(on, sig)
    const got = r.ok ? (Array.isArray(r.value) ? r.value[0] : r.value) : null
    if (!got || !isAddressEqual(got, comp.address))
      ctx.failures.push(
        `component ${comp.role}: ${comp.via ? `${comp.via}.` : ''}${comp.getter} = ${got ?? r.error}`,
      )
    else ctx.checks++
  }
}

async function checkParams(e, ctx) {
  for (const p of e.mechanism?.paramChecks || []) {
    const name = p.getter.replace(/\(\)$/, '')
    const r = await call(
      e.address,
      p.kind === 'address'
        ? `function ${name}() view returns (address)`
        : `function ${name}() view returns (uint256)`,
    )
    if (!r.ok) {
      ctx.warnings.push(`param ${p.getter} unreadable`)
      continue
    }
    const got = p.kind === 'address' ? getAddress(r.value) : r.value.toString()
    const want = p.kind === 'address' ? getAddress(p.expected) : String(p.expected)
    if (got !== want) ctx.warnings.push(`PARAM DRIFT ${p.getter}: ${got} (catalog ${want})`)
  }
}

// Oldest Chainlink-style component age, for view adapters that carry no updatedAt.
async function componentAge(e) {
  let oldest = null
  for (const comp of e.mechanism?.components || []) {
    const r = await call(
      comp.address,
      'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
    )
    if (r.ok && Number(r.value[3]) > 0) {
      const age = Number(BLOCK_TS) - Number(r.value[3])
      oldest = oldest == null ? age : Math.max(oldest, age)
    }
  }
  return oldest
}

// ---- per-entry driver -----------------------------------------------------------
let BLOCK_TS
async function verifyEntry(e, assets) {
  const ctx = { failures: [], warnings: [], notes: [], checks: 0 }
  const asset = assets.get(e.asset)
  if (!asset) ctx.failures.push(`unknown asset ${e.asset}`)
  const code = await client
    .getCode({ address: e.address, blockNumber: BLOCK })
    .catch((err) => ({ error: scrub(err.message) }))
  if (!code || code === '0x' || code.error) {
    ctx.failures.push(code?.error ? `getCode failed: ${code.error}` : 'no bytecode at address')
    return { e, ctx, price: null }
  }
  const r = await readPrice(e, ctx)
  let price = null
  let age = null
  if (!r.ok) ctx.failures.push(`read ${e.readMethod} failed: ${r.error}`)
  else {
    price = r.price
    if (r.updatedAt) age = Number(BLOCK_TS) - r.updatedAt
    if (!Number.isFinite(price) || price <= 0) ctx.failures.push(`non-positive price ${price}`)
    const range = asset?.sanity?.[e.quoteUnit]
    if (!range) ctx.failures.push(`no sanity range for ${e.asset} in ${e.quoteUnit}`)
    else if (price < range[0] || price > range[1])
      ctx.failures.push(
        `price ${fmt(price)} ${e.quoteUnit} outside sanity [${range[0]}, ${range[1]}]`,
      )
  }
  await checkIdentity(e, ctx)
  await checkUsedBy(e, ctx, asset ?? {}, price)
  await checkComponents(e, ctx, ENTRY_BY_ID)
  await checkParams(e, ctx)

  // Staleness (warning only).
  const hb = e.mechanism?.heartbeatSeconds
  let stale = null
  if (e.mechanism?.updateModel === 'pull' && age != null) stale = age > 3600
  else if (age != null && hb) stale = age > hb + graceFor(hb)
  else if (age == null && hb && e.mechanism?.updateModel === 'on_read_view') {
    const cAge = await componentAge(e)
    if (cAge != null) {
      age = cAge
      stale = cAge > hb + graceFor(hb)
      ctx.notes.push('age = oldest component')
    }
  }
  if (stale)
    ctx.warnings.push(`STALE: age ${dur(age)} > heartbeat ${hb ? dur(hb) : '1h (pull)'} + grace`)
  return { e, ctx, price, age, stale }
}

// ---- formatting -------------------------------------------------------------------
function fmt(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (n >= 1) return n.toFixed(5)
  return n.toPrecision(6)
}
function dur(s) {
  if (s == null) return '—'
  if (s < 120) return `${s}s`
  if (s < 7200) return `${Math.round(s / 60)}m`
  if (s < 172800) return `${(s / 3600).toFixed(1)}h`
  return `${(s / 86400).toFixed(0)}d`
}
const pad = (s, n) => String(s).padEnd(n).slice(0, n)

async function pool(items, n, worker) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++
        out[k] = await worker(items[k])
      }
    }),
  )
  return out
}

// ---- main ---------------------------------------------------------------------------
const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'))
const ENTRY_BY_ID = new Map(catalog.entries.map((e) => [e.id, e]))
const assets = new Map(catalog.assets.map((a) => [a.key, a]))
const head = await client.getBlockNumber()
BLOCK = head - 2n
BLOCK_TS = (await client.getBlock({ blockNumber: BLOCK })).timestamp
const entries = catalog.entries.filter((e) => !ONLY || e.id.toLowerCase().includes(ONLY))
console.log(
  `oracle-registry verify — block ${BLOCK} (${new Date(Number(BLOCK_TS) * 1000).toISOString()}), ${entries.length} entries\n`,
)

const results = await pool(entries, CONCURRENCY, (e) => verifyEntry(e, assets))

console.log(
  `${pad('id', 44)} ${pad('class/role', 26)} ${pad('price', 14)} ${pad('quote', 10)} ${pad('age', 6)} ${pad('chk', 3)} status`,
)
console.log('-'.repeat(122))
let currentAsset = null
for (const { e, ctx, price, age } of results) {
  if (e.asset !== currentAsset) {
    currentAsset = e.asset
    console.log(`· ${e.asset}`)
  }
  const status = ctx.failures.length ? 'FAIL' : ctx.warnings.length ? 'ok*' : 'ok'
  const quote =
    e.quoteAsset && e.quoteAsset !== e.quoteUnit ? `${e.quoteUnit}/${e.quoteAsset}` : e.quoteUnit
  console.log(
    `${pad(e.id, 44)} ${pad(`${e.class}/${e.consensus.role}`, 26)} ${pad(fmt(price), 14)} ${pad(quote, 10)} ${pad(dur(age), 6)} ${pad(ctx.checks, 3)} ${status}`,
  )
  for (const f of ctx.failures) console.log(`    ✗ ${f}`)
  for (const w of ctx.warnings) console.log(`    ! ${w}`)
  for (const n of ctx.notes) console.log(`    · ${n}`)
}
const failed = results.filter((r) => r.ctx.failures.length)
const warned = results.filter((r) => !r.ctx.failures.length && r.ctx.warnings.length)
const staleCount = results.filter((r) => r.stale).length
const usedByChecks = results.reduce((s, r) => s + r.ctx.checks, 0)
console.log(
  `\n${results.length - failed.length}/${results.length} verified · ${failed.length} failed · ${warned.length} with warnings (${staleCount} stale) · ${usedByChecks} wiring checks passed`,
)

if (WRITE) {
  const at = new Date(Number(BLOCK_TS) * 1000).toISOString()
  const byId = new Map(results.map((r) => [r.e.id, r]))
  for (const e of catalog.entries) {
    const r = byId.get(e.id)
    if (!r) continue
    e.status = r.ctx.failures.length ? 'unverified' : 'verified'
    if (r.ctx.failures.length) e.statusReason = r.ctx.failures.join('; ')
    else delete e.statusReason
    e.verifiedAt = at
    e.verifiedBlock = Number(BLOCK)
    if (r.ctx.access) e.mechanism.publicRead = r.ctx.access
  }
  writeFileSync(CATALOG, JSON.stringify(catalog, null, 2) + '\n')
  const latest = {
    block: Number(BLOCK),
    at,
    results: results.map(({ e, ctx, price, age, stale }) => ({
      id: e.id,
      status: ctx.failures.length ? 'unverified' : 'verified',
      price,
      quoteUnit: e.quoteUnit,
      ageSeconds: age ?? null,
      stale: stale ?? null,
      failures: ctx.failures,
      warnings: ctx.warnings,
      notes: ctx.notes,
      ...(ctx.livePrice != null ? { livePrice: ctx.livePrice } : {}),
    })),
  }
  writeFileSync(LATEST, JSON.stringify(latest, null, 2) + '\n')
  console.log(
    `wrote status → ${CATALOG.replace(ROOT + '/', '')} and ${LATEST.replace(ROOT + '/', '')}`,
  )
}
process.exit(failed.length ? 1 : 0)
