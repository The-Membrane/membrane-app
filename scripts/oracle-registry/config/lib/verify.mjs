// Source verification of an address (an implementation, a rate provider, an oracle source) from
// keyless public verifiers: Sourcify (v2 API) first, Blockscout second. AD-9 is red unless the
// source is verified; a lookup that FAILED is `null` (not read) — never taken as verified.
// Only definite answers are cached (data/oracle-registry/config/.cache/verification.json).

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { pool, scrub } from './rpc.mjs'

async function get(url) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 20_000)
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } })
    const body = r.status === 200 ? await r.json().catch(() => null) : null
    return { status: r.status, body }
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
    if (r.status === 200 && r.body?.match) return true
    if (r.status === 404 || (r.status === 200 && !r.body?.match)) sourcify = false
  } catch (e) {
    void scrub(e)
  }
  let blockscout = null
  try {
    const r = await get(`https://eth.blockscout.com/api/v2/smart-contracts/${a}`)
    if (r.status === 200)
      blockscout = !!(
        r.body?.is_verified ||
        r.body?.is_fully_verified ||
        r.body?.is_partially_verified
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
  const cache =
    cacheFile && existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {}
  const out = {}
  const todo = [...new Set(addresses.map((a) => a.toLowerCase()))].filter(
    (a) => cache[a] === undefined,
  )
  await pool(todo, 3, async (a) => {
    const v = await sourceVerified(a)
    out[a] = v
    if (v !== null) cache[a] = v
  })
  for (const a of addresses.map((x) => x.toLowerCase())) out[a] = cache[a] ?? out[a] ?? null
  if (cacheFile) writeFileSync(cacheFile, JSON.stringify(cache))
  const vals = Object.values(out)
  log(
    `source verification: ${vals.filter((v) => v === true).length}/${vals.length} verified, ${vals.filter((v) => v === false).length} NOT verified, ${vals.filter((v) => v === null).length} not read`,
  )
  return out
}
