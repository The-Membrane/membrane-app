// Read specs for the oracle registry collector: for each catalog entry, which on-chain calls
// produce its price, its component ages and its mechanism parameters, and how to decode them.
//
// Calls are plain {address, sig, args} so the collector can batch them through Multicall3 at
// any block (head or archive). Chronicle is the exception: its reads are tolled and only an
// eth_call FROM address(0) passes, so those are marked `direct` and never go through Multicall3
// (whose msg.sender is the Multicall3 contract).
//
// The decode rules mirror scripts/oracle-registry/verify-catalog.mjs (same decimals, same
// Uniswap tick orientation, same Pyth expo handling) — that script is the address verifier,
// this one is the time-series reader.

import { getAddress, parseAbi } from 'viem'

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'

export const SIG = {
  latestRoundData: 'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
  latestAnswer: 'function latestAnswer() view returns (int256)',
  price: 'function price() view returns (uint256)',
  lastGoodPrice: 'function lastGoodPrice() view returns (uint256)',
  // fetchPrice() is state-changing but harmless under eth_call: it is the price the next
  // Liquity branch operation would use (lastGoodPrice is only the last STORED one).
  fetchPrice: 'function fetchPrice() view returns (uint256,bool)',
  getPriceUnsafe:
    'function getPriceUnsafe(bytes32) view returns ((int64 price,uint64 conf,int32 expo,uint256 publishTime))',
  observe: 'function observe(uint32[]) view returns (int56[],uint160[])',
  getPtToAssetRate: 'function getPtToAssetRate(address,uint32) view returns (uint256)',
  getOracleState: 'function getOracleState(address,uint32) view returns (bool,uint16,bool)',
  readWithAge: 'function readWithAge() view returns (uint256,uint256)',
  aggregator: 'function aggregator() view returns (address)',
  phaseId: 'function phaseId() view returns (uint16)',
  getSourceOfAsset: 'function getSourceOfAsset(address) view returns (address)',
  bar: 'function bar() view returns (uint8)',
  blockTimestamp: 'function getCurrentBlockTimestamp() view returns (uint256)',
}

const abiCache = new Map()
export function abiOf(sig) {
  if (!abiCache.has(sig)) abiCache.set(sig, parseAbi([sig]))
  return abiCache.get(sig)
}

/** Error text with anything URL-shaped removed — RPC URLs carry keys. */
export const scrub = (msg) =>
  String(msg ?? '')
    .replace(/https?:\/\/\S+/g, '[rpc]')
    .replace(/wss?:\/\/\S+/g, '[rpc]')
    .split('\n')[0]
    .slice(0, 160)

/**
 * Last-resort error output for the CLI scripts. Left alone, an RPC failure that escapes a
 * top-level await is printed by Node in full — and viem's error carries a `URL:` line and a
 * `url` field with the key in its path (viem strips only user:pass@). Print the scrubbed
 * first line instead and exit 1.
 */
export function guardProcessErrors(label, proc = process) {
  const fail = (e) => {
    proc.stderr.write(`${label} failed: ${scrub(e?.shortMessage || e?.message || e)}\n`)
    proc.exit(1)
  }
  proc.on('unhandledRejection', fail)
  proc.on('uncaughtException', fail)
}

const toNum = (v, decimals) => Number(v) / 10 ** decimals
/** 9 significant digits: plenty for a price, ~half the JSON bytes of a raw double. */
export const sig9 = (n) => (n == null || !Number.isFinite(n) ? null : Number(n.toPrecision(9)))

const getterSig = (getter, kind) => {
  const name = getter.replace(/\(\)$/, '')
  return kind === 'address'
    ? `function ${name}() view returns (address)`
    : `function ${name}() view returns (uint256)`
}

// ---- price -------------------------------------------------------------------------------

/** The calls that produce an entry's price. Tag 'p' is the price itself. */
export function priceCalls(e) {
  const a = e.address
  switch (e.readMethod) {
    case 'latestRoundData()':
      return [{ tag: 'p', address: a, sig: SIG.latestRoundData }]
    case 'latestAnswer()':
      return [{ tag: 'p', address: a, sig: SIG.latestAnswer }]
    case 'price()':
      return [{ tag: 'p', address: a, sig: SIG.price }]
    case 'readWithAge()':
      return [{ tag: 'p', address: a, sig: SIG.readWithAge, direct: true }]
    case 'lastGoodPrice()':
      return [
        { tag: 'p', address: a, sig: SIG.lastGoodPrice },
        { tag: 'live', address: a, sig: SIG.fetchPrice },
      ]
    case 'getPriceUnsafe(bytes32)':
      return [{ tag: 'p', address: a, sig: SIG.getPriceUnsafe, args: [e.readArgs[0]] }]
    case 'observe(uint32[])':
      return [
        {
          tag: 'p',
          address: a,
          sig: SIG.observe,
          args: [[Number(e.readArgs[0]), Number(e.readArgs[1] ?? 0)]],
        },
      ]
    case 'getPtToAssetRate(address,uint32)': {
      const args = [getAddress(e.readArgs[0]), Number(e.readArgs[1])]
      return [
        { tag: 'p', address: a, sig: SIG.getPtToAssetRate, args },
        { tag: 'state', address: a, sig: SIG.getOracleState, args },
      ]
    }
    default:
      return []
  }
}

/**
 * Decode an entry's price from its call results (Map tag → {ok, value, error}).
 * Returns { price, updatedAt, extras, warnings, error } in the entry's own quote unit.
 */
export function decodePrice(e, res) {
  const p = res.get('p')
  const out = { price: null, updatedAt: null, extras: {}, warnings: [] }
  if (!p) return { ...out, error: `no reader for ${e.readMethod}` }
  if (!p.ok) {
    // Liquity: fall back to fetchPrice if lastGoodPrice failed (never seen; defensive).
    return { ...out, error: `read ${e.readMethod} failed: ${scrub(p.error)}` }
  }
  const v = p.value
  switch (e.readMethod) {
    case 'latestRoundData()': {
      out.price = toNum(v[1], e.decimals)
      const t = Number(v[3])
      out.updatedAt = t > 0 ? t : null
      break
    }
    case 'latestAnswer()':
    case 'price()':
      out.price = toNum(v, e.decimals)
      break
    case 'readWithAge()':
      out.price = toNum(v[0], e.decimals)
      out.updatedAt = Number(v[1]) || null
      break
    case 'lastGoodPrice()': {
      const last = toNum(v, e.decimals)
      out.extras.lastGoodPrice = sig9(last)
      const live = res.get('live')
      if (live?.ok && !live.value[1]) {
        out.price = toNum(live.value[0], 18)
      } else {
        out.price = last
        out.warnings.push(
          live?.ok
            ? 'fetchPrice() reports an oracle failure: lastGoodPrice in use'
            : 'fetchPrice() unreadable',
        )
        out.extras.oracleFailure = live?.ok ? true : null
      }
      break
    }
    case 'getPriceUnsafe(bytes32)': {
      const { price, conf, expo, publishTime } = v
      if (-expo !== e.decimals) out.warnings.push(`pyth expo ${expo} ≠ -decimals ${e.decimals}`)
      out.price = Number(price) * 10 ** expo
      out.updatedAt = Number(publishTime) || null
      out.extras.conf = sig9(Number(conf) * 10 ** expo)
      break
    }
    case 'observe(uint32[])': {
      const t = e.mechanism.twap
      const window = Number(e.readArgs[0])
      const [c0, c1] = v[0]
      const delta = c1 - c0
      let tick = Number(delta / BigInt(window))
      if (delta < 0n && delta % BigInt(window) !== 0n) tick -= 1 // round toward −∞ like OracleLibrary
      // Uniswap sorts token0 < token1 by address, so orientation needs no extra call.
      const baseIs0 = t.baseToken.toLowerCase() < t.quoteToken.toLowerCase()
      const dec0 = baseIs0 ? t.baseDecimals : t.quoteDecimals
      const dec1 = baseIs0 ? t.quoteDecimals : t.baseDecimals
      const p1per0 = Math.pow(1.0001, tick) * 10 ** (dec0 - dec1)
      out.price = baseIs0 ? p1per0 : 1 / p1per0
      out.extras.tick = tick
      break
    }
    case 'getPtToAssetRate(address,uint32)': {
      out.price = toNum(v, e.decimals)
      const st = res.get('state')
      if (st?.ok && (st.value[0] || !st.value[2]))
        out.warnings.push('TWAP window not satisfied (getOracleState)')
      break
    }
    default:
      return { ...out, error: `no decoder for ${e.readMethod}` }
  }
  if (!Number.isFinite(out.price) || out.price <= 0) {
    out.error = `non-positive price ${out.price}`
    out.price = null
  }
  return out
}

// ---- components (ages for views without an updatedAt) ----------------------------------

const OWN_CLOCK = new Set(['latestRoundData()', 'readWithAge()', 'getPriceUnsafe(bytes32)'])

/**
 * Whether an entry's age comes from its components: its own read carries no timestamp, or
 * the catalog says the timestamp it returns is the read time (Spark's medians).
 */
export const agesFromComponents = (e) =>
  !OWN_CLOCK.has(e.readMethod) || e.mechanism?.timestampIsReadTime === true

/** latestRoundData on each component (nested `via` legs included), for agesFromComponents. */
export function componentCalls(e) {
  if (!agesFromComponents(e)) return []
  return (e.mechanism.components || []).map((c) => ({
    tag: `c:${c.role}`,
    address: c.address,
    sig: SIG.latestRoundData,
  }))
}

export function decodeComponents(e, res) {
  const out = []
  for (const c of e.mechanism.components || []) {
    const r = res.get(`c:${c.role}`)
    if (!r?.ok) continue // not a feed (vault, token, market) — it has no clock to inherit
    const t = Number(r.value[3])
    if (t > 0) out.push({ role: c.role, address: c.address, updatedAt: t })
  }
  return out
}

// ---- mechanism parameters (for the change detector) --------------------------------------

/** On-chain parameter reads. Tag = the parameter name in snapshot.params. */
export function paramCalls(e) {
  const out = []
  if (e.provider === 'chainlink' && e.readMethod === 'latestRoundData()') {
    out.push({ tag: 'aggregator', address: e.address, sig: SIG.aggregator })
    out.push({ tag: 'phaseId', address: e.address, sig: SIG.phaseId })
  }
  for (const p of e.mechanism.paramChecks || []) {
    out.push({
      tag: p.getter.replace(/\(\)$/, ''),
      address: e.address,
      sig: getterSig(p.getter, p.kind),
    })
  }
  const comps = e.mechanism.components || []
  for (const c of comps) {
    if (!c.getter) continue
    const name = c.getter.replace(/\(\)$/, '')
    // A nested leg's getter lives on its parent component, not on the entry.
    const on = c.via ? comps.find((p) => p.role === c.via)?.address : e.address
    if (!on) continue
    out.push({
      tag: `component:${c.role}`,
      address: on,
      sig:
        c.getterKind === 'struct0'
          ? `function ${name}() view returns (address,uint256,uint8)`
          : `function ${name}() view returns (address)`,
    })
  }
  for (const u of e.usedBy || []) {
    if (u.check?.type !== 'aave_source') continue
    out.push({
      tag: `source:${u.protocol} ${u.market}`,
      address: u.check.oracle,
      sig: SIG.getSourceOfAsset,
      args: [u.check.asset],
    })
  }
  if (e.provider === 'chronicle') out.push({ tag: 'bar', address: e.address, sig: SIG.bar })
  return out
}

/** Storage-slot parameters (adapters with no getter), e.g. Aave's capped USDT priceCap. */
export function storageParams(e) {
  const cap = e.mechanism.cap
  if (cap?.kind !== 'price_cap') return []
  const m = /storage slot (\d+)/.exec(String(cap.note || ''))
  return m ? [{ tag: 'priceCap', address: e.address, slot: Number(m[1]) }] : []
}

export function decodeParams(e, res) {
  const params = {}
  for (const call of paramCalls(e)) {
    const r = res.get(call.tag)
    if (!r?.ok) continue // unreadable ≠ changed: leave it out
    let v = Array.isArray(r.value) ? r.value[0] : r.value
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) v = getAddress(v)
    else if (typeof v === 'bigint') v = v.toString()
    params[call.tag] = v
  }
  for (const s of storageParams(e)) {
    const r = res.get(s.tag)
    if (r?.ok) params[s.tag] = BigInt(r.value).toString()
  }
  return params
}

/** Catalog-declared mechanism parameters (diffed as origin 'catalog'). */
export function configOf(e) {
  const m = e.mechanism
  const c = {
    address: e.address,
    readMethod: e.readMethod,
    class: e.class,
    role: e.consensus.role,
    updateModel: m.updateModel,
  }
  if (m.heartbeatSeconds != null) c.heartbeatSeconds = m.heartbeatSeconds
  if (m.deviationThresholdBps != null) c.deviationThresholdBps = m.deviationThresholdBps
  if (m.twapWindowSeconds != null) c.twapWindowSeconds = m.twapWindowSeconds
  return c
}
