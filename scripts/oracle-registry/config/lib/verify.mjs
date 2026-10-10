// Source verification of an address (an implementation, a rate provider, an oracle source) from
// keyless public verifiers: Sourcify (v2 API) first, Blockscout second. AD-9 is red unless the
// source is verified; a lookup that FAILED is `null` (not read) — never taken as verified.
// Only a VERIFIED answer is cached (data/oracle-registry/config/.cache/verification.json): a
// "not verified" is asked again every run (fail-closed audit PO-11: a malformed 200 was cached as
// "not verified" for good, and a later verification was never picked up).

import { existsSync, readFileSync } from 'fs'
import { writeJsonAtomic } from './files.mjs'
import { pool, scrub } from './rpc.mjs'

async function get(url) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 20_000)
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } })
    if (r.status !== 200) return { status: r.status, body: null }
    // fail-closed audit (PO-11): a 200 that is not JSON (an HTML error page) is NOT an answer
    const body = await r.json().catch(() => undefined)
    if (body === undefined || body === null || typeof body !== 'object')
      return { status: 'bad_body', body: null }
    return { status: 200, body }
  } finally {
    clearTimeout(t)
  }
}

/** true = verified, false = not verified on either service, null = could not be read. */
export async function sourceVerified(address, chainId = 1) {
  const a = address.toLowerCase()
  let sourcify = null
  try {
    const r = await get(`https://sourcify.dev/server/v2/contract/${chainId}/${a}`)
    // a 200 is an answer only when it carries the `match` field (null = not verified)
    if (r.status === 200 && r.body?.match) return true
    if (r.status === 404 || (r.status === 200 && 'match' in r.body && !r.body.match))
      sourcify = false
  } catch (e) {
    void scrub(e)
  }
  let blockscout = null
  try {
    const r = await get(`https://eth.blockscout.com/api/v2/smart-contracts/${a}`)
    // a 200 is an answer only when it says whether the source is verified (a boolean)
    if (r.status === 200 && typeof r.body?.is_verified === 'boolean')
      blockscout = !!(
        r.body.is_verified ||
        r.body.is_fully_verified ||
        r.body.is_partially_verified
      )
    else if (r.status === 404) blockscout = false
  } catch (e) {
    void scrub(e)
  }
  if (blockscout === true) return true
  if (sourcify === false && blockscout === false) return false
  return null
}

/**
 * Verification of an address that may be a PROXY (review round 5): a verified proxy in front of
 * an unverified implementation is not verified. `impl` undefined = not a proxy (the address's
 * own verification stands); null = the implementation's verification was not read.
 */
export function combineVerification(proxy, impl) {
  if (impl === undefined) return proxy
  if (proxy === false || impl === false) return false
  if (proxy === null || impl === null) return null
  return proxy && impl
}

/**
 * Fail-closed audit (PO-13): the EIP-1967 implementation from a getStorageAt answer. Only a
 * well-formed 32-byte word is an answer: zero = not a proxy (undefined); anything else (null, a
 * short '0x', a non-string) = NOT READ (null) — it read as "not a proxy", so a verified proxy in
 * front of an unverified implementation passed AD-9.
 */
export function implFromSlotWord(w) {
  if (typeof w !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(w)) return null
  if (/^0x0{64}$/.test(w)) return undefined
  return ('0x' + w.slice(-40)).toLowerCase()
}

/**
 * `implOf(address)` → the EIP-1967 implementation behind it (lower-case), undefined when it is
 * not a proxy, null when the slot could not be read. The returned map is proxy-aware.
 */
export async function verifySourcesThroughProxies(addresses, implOf, cacheFile, log = () => {}) {
  const impls = {}
  await pool([...new Set(addresses.map((a) => a.toLowerCase()))], 4, async (a) => {
    impls[a] = await implOf(a)
  })
  const own = await verifySources(
    [...addresses, ...Object.values(impls).filter((x) => typeof x === 'string')],
    cacheFile,
    log,
  )
  const out = {}
  for (const a of addresses.map((x) => x.toLowerCase())) {
    const i = impls[a]
    out[a] = combineVerification(
      own[a] ?? null,
      i === undefined ? undefined : i === null ? null : (own[i] ?? null),
    )
  }
  const proxied = Object.values(impls).filter((x) => x !== undefined).length
  log(`source verification through proxies: ${proxied} proxies resolved to their implementation`)
  return out
}

export async function verifySources(addresses, cacheFile, log = () => {}) {
  let cache = {}
  if (cacheFile && existsSync(cacheFile))
    try {
      cache = JSON.parse(readFileSync(cacheFile, 'utf8'))
    } catch (e) {
      // an unreadable cache is re-built (fail closed: every address is asked again)
      log(`verification cache unreadable (${scrub(e?.message ?? e)}): re-read`)
      cache = {}
    }
  // only a VERIFIED answer is kept: a cached "not verified" (older runs) is asked again
  for (const [k, v] of Object.entries(cache)) if (v !== true) delete cache[k]
  const out = {}
  const todo = [...new Set(addresses.map((a) => a.toLowerCase()))].filter(
    (a) => cache[a] === undefined,
  )
  await pool(todo, 3, async (a) => {
    const v = await sourceVerified(a)
    out[a] = v
    if (v === true) cache[a] = v
  })
  for (const a of addresses.map((x) => x.toLowerCase())) out[a] = cache[a] ?? out[a] ?? null
  if (cacheFile) writeJsonAtomic(cacheFile, cache)
  const vals = Object.values(out)
  log(
    `source verification: ${vals.filter((v) => v === true).length}/${vals.length} verified, ${vals.filter((v) => v === false).length} NOT verified, ${vals.filter((v) => v === null).length} not read`,
  )
  return out
}
