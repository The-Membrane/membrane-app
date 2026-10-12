// RPC plumbing for the config-card collector: Ethereum clients from RECORDER_RPC_URL, public
// clients for other chains (LayerZero metadata RPC lists), retry / pool / adaptive getLogs and a
// resumable chunk cache. Mirrors scripts/oracle-registry/collect.mjs (10k-block spans,
// concurrency 2, log scans only on the keyed Ankr endpoint with Infura as backup).
//
// URLs carry keys: nothing here ever prints one. Errors go through scrub().

import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks'
import { createHash } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { createPublicClient, defineChain, fallback, http } from 'viem'
import { readEnv } from '../../../lib/venue-reads.mjs'
import { scrub as scrubUrls } from '../../lib/readers.mjs'
import { EVENT_SIGS, decodeLog } from './abi.mjs'
import { writeJsonAtomic } from './files.mjs'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- transport (lane T, 2026-10-11) -----------------------------------------------------------
// The first CI run lost 204 scan chunks to "HTTP request failed." from the SECOND log endpoint
// (the UQ-23 cross-check host): every empty primary range was confirmed there in 10k-block
// pieces, unpaced, retried twice at 400 / 800 ms — over a free tier's credit rate — and the gap
// text kept neither the host nor the HTTP status. Here: (1) a per-host limiter paces the
// cross-check host; (2) `retryRpc` retries transient failures (429, 5xx, timeouts, no response)
// with exponential backoff + jitter, honouring Retry-After, and never retries a deterministic
// revert or a refused block range (the caller splits that); (3) every failure is DESCRIBED with
// the provider's registrable domain and the HTTP status or error class, never a URL, a
// subdomain, a path, a port or a key. Only how reads are made, retried and described changed:
// a read that still fails is the same failure (a gap) it was.

/**
 * Transport tuning, read at call time. Production defaults; under vitest (`VITEST`) the waits
 * default to ~0 so suites that fake failing endpoints keep their timing. An explicit env value
 * always wins:
 *   ORACLE_REGISTRY_RPC_TRIES            tries for a transient failure (default 5)
 *   ORACLE_REGISTRY_RPC_BACKOFF_MS       first backoff (default 1000; doubles per try, jittered)
 *   ORACLE_REGISTRY_RPC_BACKOFF_CAP_MS   one wait at most (default 20000; Retry-After clamped)
 *   ORACLE_REGISTRY_RPC_RETRY_BUDGET_MS  all waits of one call at most (default 60000)
 *   ORACLE_REGISTRY_XCHECK_INTERVAL_MS   cross-check host: min ms between request starts
 *                                        (default 1000 = 1 req/s, one in flight)
 */
export function rpcTuning(env = process.env) {
  const testing = !!env.VITEST
  const num = (k, d) => {
    const v = Number(env[k])
    return env[k] !== undefined && env[k] !== '' && Number.isFinite(v) && v >= 0 ? v : d
  }
  return {
    tries: Math.max(1, Math.floor(num('ORACLE_REGISTRY_RPC_TRIES', 5))),
    baseMs: num('ORACLE_REGISTRY_RPC_BACKOFF_MS', testing ? 1 : 1000),
    capMs: num('ORACLE_REGISTRY_RPC_BACKOFF_CAP_MS', testing ? 10 : 20_000),
    budgetMs: num('ORACLE_REGISTRY_RPC_RETRY_BUDGET_MS', testing ? 50 : 60_000),
    crossCheckIntervalMs: num('ORACLE_REGISTRY_XCHECK_INTERVAL_MS', testing ? 0 : 1000),
  }
}

// Public suffixes with two labels (a registrable domain is then three labels).
const TWO_LABEL_SUFFIX = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'com.au',
  'net.au',
  'co.jp',
  'com.br',
  'co.kr',
  'com.cn',
  'co.nz',
  'co.in',
  'com.sg',
  'com.hk',
])
/**
 * The provider label of an RPC URL: its REGISTRABLE domain only (rpc.ankr.com → ankr.com,
 * <id>.ethereum-mainnet.quiknode.pro → quiknode.pro). Never a subdomain (an account id), a path
 * (a key), a port, a query or credentials. An IP host is "an IP host".
 */
export function hostLabel(u) {
  let h
  try {
    h = new URL(String(u)).hostname.toLowerCase()
  } catch {
    return null
  }
  if (!h) return null
  if (h.includes(':') || h.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return 'an IP host'
  const parts = h.split('.').filter(Boolean)
  if (parts.length <= 2) return parts.join('.')
  const last2 = parts.slice(-2).join('.')
  return TWO_LABEL_SUFFIX.has(last2) ? parts.slice(-3).join('.') : last2
}

// Every key-bearing part of the configured RPC URLs (path segments, query values, subdomains,
// credentials): redacted from any message, wherever a provider echoes it without the scheme.
const secrets = new Set()
const rpcHosts = new Map() // configured hostname → its label
const rpcDomains = new Set() // the configured registrable domains (any subdomain of one → it)
// Network names shared by every account of a provider (mainnet.infura.io, eth-mainnet.g.alchemy
// .com, drpc's ?network=ethereum): not secrets, so the WORD "mainnet" in a message is not "[key]".
// An account's own subdomain (a QuickNode id), path key or query key is never one of these.
const PUBLIC_LABELS = new Set(['mainnet', 'ethereum', 'ethereum-mainnet', 'eth-mainnet'])
export function registerRpcSecrets(urls) {
  for (const raw of urls ?? []) {
    const u = String(raw)
    let x
    try {
      x = new URL(u)
    } catch {
      if (u.length >= 8) secrets.add(u)
      continue
    }
    const label = hostLabel(u)
    const keep = (label ?? '').split('.').filter(Boolean).length
    if (label) rpcHosts.set(x.hostname.toLowerCase(), label)
    if (label && label.includes('.') && label !== 'an IP host') rpcDomains.add(label)
    const labels = x.hostname.split('.')
    for (const l of labels.slice(0, Math.max(0, labels.length - keep)))
      if (l.length >= 6 && !PUBLIC_LABELS.has(l.toLowerCase())) secrets.add(l)
    for (const s of x.pathname.split('/')) {
      let d = s
      try {
        d = decodeURIComponent(s)
      } catch {
        /* the raw segment */
      }
      if (s.length >= 8 && !PUBLIC_LABELS.has(s.toLowerCase())) secrets.add(s)
      if (d.length >= 8 && !PUBLIC_LABELS.has(d.toLowerCase())) secrets.add(d)
    }
    for (const [, v] of x.searchParams)
      if (v.length >= 8 && !PUBLIC_LABELS.has(v.toLowerCase())) secrets.add(v)
    if (x.username) secrets.add(x.username)
    if (x.password) secrets.add(x.password)
  }
}
// A key-like token: 24+ of [A-Za-z0-9_-] with a digit and a letter, not 0x-prefixed (addresses,
// hashes and selectors stay readable).
const KEYLIKE =
  /(?<![0-9A-Za-z_-])(?!0x)(?=[0-9A-Za-z_-]*\d)(?=[0-9A-Za-z_-]*[A-Za-z])[0-9A-Za-z_-]{24,}(?![0-9A-Za-z_-])/g
// A host written without its scheme, with a port or a path ("rpc.ankr.com/eth/…",
// "lb.drpc.org:8443/…"): a provider echoing its own URL. Replaced whole, like a URL.
const HOSTPART = String.raw`(?:[A-Za-z0-9-]+|\[key\])`
const BARE_URL = new RegExp(
  String.raw`(?<![\w@.-])${HOSTPART}(?:\.${HOSTPART})*\.[A-Za-z]{2,}(?::\d{1,5})?(?:\/\S*|(?<=:\d{1,5}))`,
  'g',
)
// An IP host (v4, or v6 in brackets), with its port and path: never written, configured or not.
const IP_HOST = new RegExp(
  String.raw`(?<![\w.])(?:(?:\d{1,3}\.){3}\d{1,3}(?![\d.]*\d)|\[[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*\])(?::\d{1,5})?(?:\/\S*)?`,
  'g',
)
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// a configured host named alone: its label; ANY subdomain chain of a configured registrable
// domain (one already partly "[key]"-redacted too): the domain only
const hostsToLabels = (s) => {
  let out = s
  for (const [h, label] of rpcHosts)
    if (out.toLowerCase().includes(h)) out = out.replace(new RegExp(escapeRe(h), 'gi'), label)
  for (const d of rpcDomains)
    if (out.toLowerCase().includes(d))
      out = out.replace(
        new RegExp(String.raw`(?<![\w@.-])(?:${HOSTPART}\.)+${escapeRe(d)}(?![\w-])`, 'gi'),
        d,
      )
  return out
}
// Review of lane T (PLAUSIBLE #2): the secret pass ran FIRST and mangled a configured hostname
// ("abc12.ethereum-mainnet.quiknode.pro" → "abc12.[key].quiknode.pro") before the host pass
// looked for it, so a subdomain label under 6 characters survived; an IP host with a port
// ("10.1.2.3:8545") survived every pass. Hosts are now replaced before AND after the secrets.
const redactSecrets = (s) => {
  // (an IP host first: its port goes with it, never "an IP host:8545")
  let out = s.replace(BARE_URL, '[rpc]').replace(IP_HOST, 'an IP host')
  out = hostsToLabels(out)
  for (const k of [...secrets].sort((a, b) => b.length - a.length))
    if (out.includes(k)) out = out.split(k).join('[key]')
  out = hostsToLabels(out.replace(BARE_URL, '[rpc]'))
  out = out.replace(IP_HOST, 'an IP host')
  return out.replace(KEYLIKE, '[key]')
}
/**
 * Error text that is safe to log, cache and commit (the repo is PUBLIC): every URL is replaced
 * (`readers.mjs` scrub: first line, 160 chars) after every registered key part and every key-like
 * token is redacted — before the cut, so a key split at the 160th character cannot survive.
 */
export const scrub = (msg) => scrubUrls(redactSecrets(String(msg ?? '')))

/** The HTTP status / Retry-After of the request in flight, noted by `notingFetch`. */
const httpCtx = new AsyncLocalStorage()
/**
 * viem 2.54 returns a non-OK answer whose body is a JSON-RPC error as an RPC error, without the
 * HTTP status or headers: this fetch notes them on the current attempt (`retryRpc`).
 */
export async function notingFetch(input, init) {
  const r = await fetch(input, init)
  if (r.ok) return r
  const ra = r.headers?.get?.('retry-after')
  const c = httpCtx.getStore()
  if (c) {
    c.status = r.status
    if (ra) c.retryAfter = ra
  }
  // Review of lane T (PLAUSIBLE #1): viem's OWN retry (retryCount 1 on a non-paced host, a
  // fallback ring's rounds) sleeps the full Retry-After before `retryRpc` sees the error — an
  // hour-long header held the read an hour. viem reads the header from this answer: clamp it to
  // the per-wait cap (the original value stays noted above; `retryRpc` clamps it the same way).
  const ms = parseRetryAfter(ra)
  const capMs = rpcTuning().capMs
  if (ms === null || ms <= capMs || !r.headers) return r
  const headers = new Headers(r.headers)
  headers.set('retry-after', String(Math.floor(capMs / 1000)))
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers })
}

/** Retry-After (seconds or an HTTP date) in ms; null when absent or unparsable. */
export function parseRetryAfter(v, now = Date.now()) {
  if (v === undefined || v === null || v === '') return null
  const s = String(v).trim()
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000)
  const t = Date.parse(s)
  return Number.isFinite(t) ? Math.max(0, t - now) : null
}

const RANGE_RE =
  /block range|range (?:is )?too (?:large|wide|big)|range exceeds|exceeds? (?:the )?(?:max(?:imum)? )?(?:block )?range|limit of \d+|more than \d+ (?:results|logs|blocks)|query returned more than|response size|results? (?:set )?(?:is )?too large|too many (?:results|logs|blocks)|range too large|ranges over \d+/i
const RATE_RE =
  /rate.?limit|too many requests|request rate|daily request|exceeded (?:the |its )?(?:quota|capacity|credits?|compute units|throughput)|capacity (?:exceeded|limit)|compute units|credits? (?:limit|exceeded)/i
const TIMEOUT_RE = /timed? ?out|took too long|timeout/i
const GENERIC_RE =
  /^(?:HTTP request failed\.?|The request took too long to respond\.?|The request timed out\.?|An unknown RPC error occurred\.?|Request exceeds defined limit\.?|An internal error was received\.?|Requested resource not available\.?)$/i

/**
 * What a failed read was, from a viem error chain (or a test fake):
 *   { kind, status, code, url, retryAfterMs, netCode, detail }
 * kind: 'revert' (deterministic: never retried) | 'range' (a refused block range / result size:
 * never retried, the caller splits) | 'rate-limit' | 'server' (5xx / 408) | 'network' (no
 * response) | 'timeout' | 'internal' (-32603 without revert data) | 'unserved' (null / non-array
 * answer) | 'other'.
 */
export function classifyRpcError(e) {
  let status
  let code
  let url
  let retryAfterMs = null
  let netCode
  let detail = null
  let explicit = null
  let http = false
  let timeoutNamed = false
  const texts = []
  for (let x = e, i = 0; x && i < 12; x = x.cause, i++) {
    if (typeof x !== 'object' && typeof x !== 'function') {
      texts.push(String(x))
      break
    }
    if (!explicit && typeof x.rpcKind === 'string' && x.rpcKind) explicit = x.rpcKind
    if (status === undefined && Number.isInteger(x.status) && x.status >= 100) status = x.status
    if (status === undefined && Number.isInteger(x.rpcHttpStatus)) status = x.rpcHttpStatus
    if (code === undefined && typeof x.code === 'number') code = x.code
    if (netCode === undefined && typeof x.code === 'string' && /^[A-Z][A-Z0-9_]{2,}$/.test(x.code))
      netCode = x.code
    if (!url && typeof x.url === 'string') url = x.url
    if (/HttpRequestError/.test(String(x.name ?? ''))) http = true
    if (/TimeoutError/.test(String(x.name ?? ''))) timeoutNamed = true
    let ra = null
    try {
      ra = parseRetryAfter(x.headers?.get?.('retry-after'))
    } catch {
      ra = null
    }
    ra ??= parseRetryAfter(x.rpcRetryAfter)
    const bo = x.data?.backoff_seconds ?? x.data?.data?.backoff_seconds
    if (ra === null && Number.isFinite(Number(bo)) && bo !== null) ra = Number(bo) * 1000
    if (ra !== null && retryAfterMs === null) retryAfterMs = ra
    const t = `${x.details ?? ''}\n${x.shortMessage ?? ''}\n${x.message ?? ''}`
    texts.push(t)
    if (detail === null)
      for (const c of [x.details, x.shortMessage, x.message]) {
        const s = typeof c === 'string' ? c.split('\n')[0].trim() : ''
        if (s && !GENERIC_RE.test(s)) {
          detail = s
          break
        }
      }
  }
  const text = texts.join('\n')
  if (status === undefined) {
    const m = /\bStatus:? (\d{3})\b|\bHTTP (\d{3})\b/.exec(text)
    if (m) status = Number(m[1] ?? m[2])
  }
  if (retryAfterMs === null) {
    const m = /retry (?:in|after) (\d+(?:\.\d+)?) ?(ms|s|sec|secs|seconds?)?\b/i.exec(text)
    if (m) retryAfterMs = Math.round(Number(m[1]) * (m[2] === 'ms' ? 1 : 1000))
  }
  let kind
  if (isRevertError(e)) kind = 'revert'
  else if (RANGE_RE.test(text) && status !== 429) kind = 'range'
  else if (status === 429 || code === -32005 || RATE_RE.test(text)) kind = 'rate-limit'
  else if (status !== undefined && (status >= 500 || status === 408)) kind = 'server'
  else if (explicit) kind = explicit
  else if (timeoutNamed || TIMEOUT_RE.test(text)) kind = 'timeout'
  else if (code === -32603) kind = 'internal'
  else if (http && status === undefined) kind = 'network'
  else kind = 'other'
  return { kind, status, code, url, retryAfterMs, netCode, detail }
}

/** Tries per kind: deterministic answers once, transient failures `tries` times. */
export function triesFor(kind, tries) {
  switch (kind) {
    case 'revert':
    case 'range':
      return 1
    case 'rate-limit':
    case 'server':
    case 'network':
      return tries
    case 'timeout':
    case 'internal':
    case 'unserved':
      return Math.min(tries, 3)
    default:
      return Math.min(tries, 2)
  }
}

/**
 * One RPC read, retried by what failed (`triesFor`): exponential backoff from `baseMs`, doubled
 * per try and jittered to [½, 1] of it, each wait ≤ `capMs`, a Retry-After (header, Infura's
 * `backoff_seconds`, "retry in Ns") honoured as a floor, and all waits of the call ≤ `budgetMs`.
 * Throws the last error. `opts` override `rpcTuning()`; `onRetry({ attempt, kind, delayMs })`.
 */
export async function retryRpc(fn, opts = {}) {
  const t = { ...rpcTuning(), ...opts }
  const rnd = t.random ?? Math.random
  let waited = 0
  for (let i = 0; ; i++) {
    const ctx = {}
    try {
      return await httpCtx.run(ctx, fn)
    } catch (e) {
      if (ctx.status && e && typeof e === 'object')
        try {
          e.rpcHttpStatus ??= ctx.status
          if (ctx.retryAfter) e.rpcRetryAfter ??= ctx.retryAfter
        } catch {
          /* a frozen error: classified without the noted status */
        }
      const c = classifyRpcError(e)
      if (i + 1 >= triesFor(c.kind, t.tries)) throw e
      const exp = Math.min(t.capMs, t.baseMs * 2 ** i)
      let d = exp / 2 + rnd() * (exp / 2)
      if (c.retryAfterMs !== null) d = Math.max(d, Math.min(c.retryAfterMs, t.capMs))
      if (waited + d > t.budgetMs) throw e
      waited += d
      t.onRetry?.({ attempt: i + 1, kind: c.kind, delayMs: d })
      await sleep(d)
    }
  }
}

const KIND_TEXT = {
  revert: () => 'reverted',
  range: () => 'block range refused',
  'rate-limit': (c) => (c.code !== undefined ? `rate limited (RPC ${c.code})` : 'rate limited'),
  server: () => 'server error',
  network: (c) => `HTTP request failed (no response${c.netCode ? `, ${c.netCode}` : ''})`,
  timeout: () => 'timeout',
  internal: (c) => `RPC internal error (${c.code ?? -32603})`,
  unserved: () => 'not served',
  other: (c) => (c.code !== undefined ? `RPC error ${c.code}` : null),
}
/**
 * A failed read in words: "HTTP 429 from infura.io (cross-check)", "timeout from ankr.com
 * (primary)", "rate limited (RPC -32005) from infura.io (cross-check): <provider text>". The
 * host is `label` (the client's) or the error's own URL as a LABEL; `role` names the endpoint's
 * part (primary / cross-check / state). Scrubbed: no URL, subdomain, path, port or key.
 */
export function describeRpcError(e, { label, role } = {}) {
  if (e?.rpcDescribed) return scrub(e.message).trim() || 'read failed (no error text)'
  const c = classifyRpcError(e)
  const host = label ?? (c.url ? hostLabel(c.url) : null)
  let head = c.status !== undefined ? `HTTP ${c.status}` : KIND_TEXT[c.kind]?.(c)
  let detail = c.detail
  if (!head) {
    head = detail ?? String(e?.message ?? e ?? 'read failed')
    detail = null
  }
  if (detail && (detail.toLowerCase() === head.toLowerCase() || /^HTTP \d{3}$/i.test(detail)))
    detail = null
  const where = `${host ? ` from ${host}` : ''}${role ? ` (${role})` : ''}`
  const d = detail ? `: ${scrub(detail).slice(0, 80)}` : ''
  // never "": callers read a non-empty description as "unread" (third review: an error whose
  // message starts with a newline described as "" and a failed read counted as read)
  return scrub(`${head}${where}${d}`).trim() || `read failed (no error text)${where}`
}
/**
 * The error a read throws after its retries: message = `describeRpcError`, the original as
 * `cause` (so `isRevertError` still sees a revert), `rpcKind` / `rpcStatus` for callers.
 */
export function rpcFailure(e, { client, role, label } = {}) {
  if (e?.rpcDescribed) return e
  const msg = describeRpcError(e, {
    label: label ?? client?.rpcLabel,
    role: role ?? client?.rpcRole,
  })
  const c = classifyRpcError(e)
  const err = new Error(msg, { cause: e })
  err.name = 'RpcReadFailure'
  err.shortMessage = msg
  err.rpcDescribed = true
  err.rpcFailedKind = c.kind
  if (c.status !== undefined) err.rpcStatus = c.status
  return err
}

/**
 * A per-host limiter: at most `maxInFlight` requests at once, request STARTS at least
 * `minIntervalMs` apart, FIFO. `penalize(ms)` holds every later start (a Retry-After). The queued
 * function runs in its caller's async context (the attempt's HTTP-status note).
 */
export function createLimiter({ minIntervalMs = 0, maxInFlight = 1 } = {}) {
  const queue = []
  let active = 0
  let nextAt = 0
  let timer = null
  const pump = () => {
    while (active < maxInFlight && queue.length) {
      const wait = nextAt - Date.now()
      if (wait > 0) {
        if (!timer)
          timer = setTimeout(() => {
            timer = null
            pump()
          }, wait)
        return
      }
      const job = queue.shift()
      active++
      nextAt = Date.now() + minIntervalMs
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .then(() => {
          active--
          pump()
        })
    }
  }
  return {
    minIntervalMs,
    run(fn) {
      return new Promise((resolve, reject) => {
        queue.push({ fn: AsyncResource.bind(fn), resolve, reject })
        pump()
      })
    },
    penalize(ms) {
      if (ms > 0) nextAt = Math.max(nextAt, Date.now() + ms)
    },
    get pending() {
      return queue.length + active
    },
  }
}
const limiters = new Map()
/** The process-wide limiter of a URL's host (shared by every client that reaches that host). */
export function hostLimiter(url, opts) {
  let k
  try {
    k = new URL(String(url)).host
  } catch {
    k = String(url)
  }
  if (!limiters.has(k)) limiters.set(k, createLimiter(opts))
  return limiters.get(k)
}
/**
 * A viem transport whose every request goes through `limiter`. A rate-limited answer holds the
 * whole host for its Retry-After (else two intervals).
 */
export function pacedTransport(transport, limiter) {
  return (opts) => {
    const t = transport(opts)
    return {
      ...t,
      request: (args, o) =>
        limiter.run(async () => {
          try {
            return await t.request(args, o)
          } catch (e) {
            const c = classifyRpcError(e)
            if (c.kind === 'rate-limit') {
              const ra = c.retryAfterMs ?? parseRetryAfter(httpCtx.getStore()?.retryAfter)
              limiter.penalize(
                Math.min(ra ?? 2 * limiter.minIntervalMs, rpcTuning().capMs || Infinity),
              )
            }
            throw e
          }
        }),
    }
  }
}

export async function retry(fn, tries = 3, base = 400) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      await sleep(base * 2 ** i)
    }
  }
  throw last
}

export async function pool(items, n, worker) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++
        out[k] = await worker(items[k], k)
      }
    }),
  )
  return out
}

const hostOf = (u) => {
  try {
    return new URL(u).host
  } catch {
    return ''
  }
}

const chainDef = (id, urls) =>
  defineChain({
    id,
    name: `chain-${id}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: urls } },
    contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
  })

/** Ethereum clients: `state` (whole ring) and `logs` (keyed Ankr first, Infura backup). */
export function ethereumClients() {
  const urls = String(
    process.env.ORACLE_REGISTRY_RPC_URL || readEnv().get('RECORDER_RPC_URL') || '',
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!urls.length) throw new Error('RECORDER_RPC_URL missing from .env.local')
  // lane T: every key-bearing part of these URLs is redacted from any message (`scrub`)
  registerRpcSecrets(urls)
  const logUrls = [
    ...urls.filter((u) => hostOf(u).includes('ankr')),
    ...urls.filter((u) => hostOf(u).includes('infura')),
  ]
  // Archive reads go to the keyed endpoint first (the free tiers refuse old blocks).
  const ordered = [...logUrls, ...urls.filter((u) => !logUrls.includes(u))]
  // UQ-23: two INDEPENDENT log endpoints (no fallback between them), so an empty answer from
  // one can be asked again on the other (the shared ring can return false-empty chunks).
  // Fail-closed audit (EV-04): the pair is two DISTINCT HOSTS — `[...logUrls, ...urls]` could
  // pick one URL twice (one log URL that is also urls[0]), and an endpoint cross-checked against
  // itself confirms its own false-empty answer. No two distinct hosts: refused at startup.
  const pair = []
  for (const u of [...logUrls, ...urls])
    if (!pair.some((x) => hostOf(x) === hostOf(u))) pair.push(u)
  if (pair.length < 2)
    throw new Error(
      'RECORDER_RPC_URL needs two distinct log hosts (an empty getLogs answer is confirmed on the second; an endpoint never cross-checks itself)',
    )
  // lane T (2026-10-11): the cross-check host is PACED — one request in flight, starts at least
  // ORACLE_REGISTRY_XCHECK_INTERVAL_MS apart (1 req/s), shared by every client that reaches that
  // host (the state ring and the logs fallback include it). Its viem-internal retry is off: each
  // retry is `retryRpc`'s, and each one is paced. The primary keeps its concurrency.
  const xHost = hostOf(pair[1])
  const xLimiter = hostLimiter(pair[1], { minIntervalMs: rpcTuning().crossCheckIntervalMs })
  const tr = (u, timeout) => {
    const paced = hostOf(u) === xHost
    const h = http(u, { timeout, retryCount: paced ? 0 : 1, fetchFn: notingFetch })
    return paced ? pacedTransport(h, xLimiter) : h
  }
  const mk = (list, timeout, role) => {
    const c = createPublicClient({
      chain: chainDef(1, list),
      transport:
        list.length === 1
          ? tr(list[0], timeout)
          : fallback(
              list.map((u) => tr(u, timeout)),
              { rank: false },
            ),
      batch: { multicall: false },
    })
    // the provider LABEL (registrable domain) of a one-host client, and the endpoint's part
    if (list.length === 1) c.rpcLabel = hostLabel(list[0])
    c.rpcRole = role
    return c
  }
  return {
    state: mk(ordered, 30_000, 'state'),
    logs: mk(logUrls.length ? logUrls : urls, 45_000, 'logs'),
    logsPrimary: mk([pair[0]], 45_000, 'primary'),
    logsSecondary: mk([pair[1]], 45_000, 'cross-check'),
  }
}

/**
 * UQ-23 (2026-10-08): one getLogs range, CROSS-CHECKED. An empty answer is asked again on a
 * second, independent endpoint — the shared ring can return false-empty chunks, and a lost
 * chunk drops a log silently:
 *   primary non-empty                           → its logs
 *   primary empty or failed, secondary non-empty → the secondary's (a false-empty corrected)
 *   both answered empty                          → [] (confirmed)
 *   otherwise (a failure and no confirming empty) → throws: the caller marks the read UNREAD
 * `secondary` null: an empty primary answer cannot be confirmed — throws (fail closed).
 * Review round 10 (R-5): a primary that FAILS on the range (a result-size or range limit) is
 * split in halves, and each half is cross-checked on its own. Before, the split ran inside one
 * adaptive read and only the combined answer was checked: one false-empty half next to a
 * non-empty half was accepted, and its log lost.
 * Returns { logs, corrected } (`corrected`: a primary empty answer was false).
 * KG-6 (closed in review round 12): the second endpoint refuses any range over 10,000 blocks, so
 * it is asked in ≤ SECONDARY_LOG_SPAN pieces from the start (`secondaryLogs`). It was asked for
 * the whole range and halved through ~63 refused (and retried) requests per empty 500k chunk; one
 * failure in that cascade left the whole proposer set unread (the rsETH 0x49bd… and wstETH Linea
 * 0xd6b9… read gaps of round 12) and made a run take 47 minutes.
 */
export const SECONDARY_LOG_SPAN = 10_000
/**
 * Fail-closed audit (EV-04, 2026-10-10): the cross-check is SYMMETRIC per piece. The second
 * endpoint is read in ≤ SECONDARY_LOG_SPAN pieces; a piece it answers EMPTY is confirmed only
 * when the first endpoint answered that very range empty AND was not itself caught answering
 * false-empty on the range (some other piece non-empty) — otherwise the first endpoint is asked
 * for that piece again: [] confirms it, logs are taken, a failure throws. Before, any non-empty
 * total of the second endpoint was accepted whole: one false-empty piece next to a non-empty one
 * lost its log, with no error. A piece the second endpoint fails on throws (the range is unread).
 */
async function secondaryPieces(client, q) {
  const out = []
  const to = BigInt(q.toBlock)
  const span = BigInt(SECONDARY_LOG_SPAN)
  for (let a = BigInt(q.fromBlock); a <= to; a += span) {
    const b = a + span - 1n < to ? a + span - 1n : to
    out.push({
      fromBlock: a,
      toBlock: b,
      logs: await getLogsOnce(client, { ...q, fromBlock: a, toBlock: b }, 'cross-check'),
    })
  }
  return out
}
/** One log's identity (transaction, index); a log without them is keyed by its content. */
const logId = (l) =>
  l.transactionHash !== undefined && l.logIndex !== undefined
    ? `${String(l.transactionHash).toLowerCase()}|${BigInt(l.logIndex)}`
    : JSON.stringify(l)
const dedupeLogs = (logs) => {
  const seen = new Set()
  return logs.filter((l) => {
    const k = logId(l)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
export async function crossCheckedLogs(primary, secondary, q, depth = 0) {
  let a = null
  let aErr = null
  try {
    a = await getLogsOnce(primary, q, 'primary')
  } catch (e) {
    aErr = e
  }
  if (a && a.length) return { logs: a, corrected: false }
  if (aErr) {
    const span = BigInt(q.toBlock) - BigInt(q.fromBlock)
    if (span >= 200n && depth <= 12) {
      const mid = BigInt(q.fromBlock) + span / 2n
      const x = await crossCheckedLogs(primary, secondary, { ...q, toBlock: mid }, depth + 1)
      const y = await crossCheckedLogs(primary, secondary, { ...q, fromBlock: mid + 1n }, depth + 1)
      return { logs: [...x.logs, ...y.logs], corrected: x.corrected || y.corrected }
    }
  }
  if (!secondary)
    throw aErr ?? new Error('empty getLogs answer not cross-checked (no second endpoint)')
  let pieces
  try {
    pieces = await secondaryPieces(secondary, q)
  } catch (e) {
    if (aErr) throw aErr
    throw e
  }
  // the first endpoint's empty answer is evidence for a piece only while it was not shown false
  const primaryEmptyHolds = !aErr && pieces.every((p) => !p.logs.length)
  const out = []
  let corrected = false
  for (const p of pieces) {
    if (p.logs.length) {
      out.push(...p.logs)
      if (!aErr) corrected = true
      continue
    }
    if (primaryEmptyHolds) continue // both endpoints answered this range empty
    // asked again on the first endpoint, for exactly this piece (throws when it fails)
    const again = await getLogsOnce(
      primary,
      { ...q, fromBlock: p.fromBlock, toBlock: p.toBlock },
      'primary',
    )
    if (again.length) {
      out.push(...again)
      corrected = true
    }
  }
  return { logs: dedupeLogs(out), corrected }
}

/** A public client for another chain from a list of public RPC URLs (LZ metadata / chainlist). */
export function publicClient(chainId, urls) {
  return createPublicClient({
    chain: chainDef(chainId, urls),
    transport: fallback(
      urls.map((u) => http(u, { timeout: 12_000, retryCount: 0 })),
      { rank: false },
    ),
  })
}

/**
 * One raw eth_getLogs request (retried, never split). Lane T: retried by what failed
 * (`retryRpc`: 429 / 5xx / timeout / no response with backoff, a refused range not at all — the
 * caller splits it); the final error names the host LABEL, the endpoint's `role` and the HTTP
 * status or error class (`rpcFailure`).
 */
async function getLogsOnce(client, { address, topics0, fromBlock, toBlock }, role) {
  const hx = (n) => '0x' + BigInt(n).toString(16)
  try {
    return await retryRpc(async () => {
      const r = await client.request({
        method: 'eth_getLogs',
        params: [{ address, topics: [topics0], fromBlock: hx(fromBlock), toBlock: hx(toBlock) }],
      })
      // fail-closed audit (EV-03): null / {} is a FAILED read, never an empty answer
      if (!Array.isArray(r))
        throw Object.assign(new Error('non-array eth_getLogs answer'), { rpcKind: 'unserved' })
      return r
    })
  } catch (e) {
    throw rpcFailure(e, { client, role })
  }
}

/**
 * Raw eth_getLogs with a topic0 OR-list. (viem's getLogs has no raw `topics` parameter: passing
 * one is silently ignored and the node returns EVERY log of the addresses — measured
 * 2026-10-06, 9,372 unrelated logs for one 10k-block span of ReceiveUln302.) Splits the range
 * in half on any error (result-size limits) down to 200 blocks.
 */
export async function getLogsAdaptive(client, { address, topics0, fromBlock, toBlock }, depth = 0) {
  try {
    return await getLogsOnce(client, { address, topics0, fromBlock, toBlock })
  } catch (e) {
    const span = BigInt(toBlock) - BigInt(fromBlock)
    if (span < 200n || depth > 12) throw e
    const mid = BigInt(fromBlock) + span / 2n
    const a = await getLogsAdaptive(
      client,
      { address, topics0, fromBlock, toBlock: mid },
      depth + 1,
    )
    const b = await getLogsAdaptive(
      client,
      { address, topics0, fromBlock: mid + 1n, toBlock },
      depth + 1,
    )
    return [...a, ...b]
  }
}

/**
 * Scan [from, to] for `topics0` on `addresses` in `span`-block chunks, decode, filter with
 * `keep(row)`, and cache every CONFIRMED chunk in `cacheDir` (resumable). Returns decoded rows
 * { chainId, block, logIndex, tx, emitter, event, args }.
 *
 * Fail-closed audit (EV-01 / EV-02 / ST-03 / KG-7, 2026-10-10). Before, every chunk was one
 * `getLogsAdaptive` on one client: an empty answer was final, it was cached, and every later run
 * skipped it — a lost RoleGranted, CallScheduled, PeerSet or OwnershipTransferred left no trace.
 *   - every address group goes through `crossCheckedLogs(primary, secondary)`: non-empty, or
 *     empty on BOTH endpoints (`client` alone: an empty answer cannot be confirmed);
 *   - a requested log that does not decode is not dropped: the chunk is unconfirmed;
 *   - only confirmed chunks are cached ({ v: 2, confirmed: true }); older lines are re-read once;
 *     the key hashes the event ABIs too, so a new variant re-decodes; a chunk ending within
 *     HEAD_MARGIN blocks of `head` is never cached (a lagging log node);
 *   - an unconfirmed chunk is pushed to `gaps` ({ scan, from, to, addresses, error }) — the
 *     collector lists it as a read gap and the engine carries what it could hide — and THROWS
 *     when no `gaps` list is given (the run stops: it never reads as "no event").
 */
export const SCAN_HEAD_MARGIN = 64
const SCAN_CACHE_VERSION = 2
const ABI_HASH = createHash('sha1').update(JSON.stringify(EVENT_SIGS)).digest('hex').slice(0, 8)
export async function scanLogs({
  client,
  primary,
  secondary,
  chainId,
  addresses,
  topics0,
  from,
  to,
  head,
  span = 100_000,
  concurrency = 2,
  cacheDir,
  cacheKey,
  keep = () => true,
  onProgress,
  gaps,
  scan = 'event scan',
}) {
  const p = primary ?? client
  const sec = primary ? (secondary ?? null) : null
  const key = createHash('sha1')
    .update(
      JSON.stringify([
        chainId,
        [...addresses].map((a) => a.toLowerCase()).sort(),
        [...topics0].sort(),
        cacheKey ?? '',
        ABI_HASH,
      ]),
    )
    .digest('hex')
    .slice(0, 12)
  mkdirSync(cacheDir, { recursive: true })
  const file = join(cacheDir, `scan-${chainId}-${key}.jsonl`)
  const done = new Map()
  if (existsSync(file))
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const c = JSON.parse(line)
        // a chunk cached before the cross-check (no confirmed mark) is read again
        if (c.v === SCAN_CACHE_VERSION && c.confirmed === true && Array.isArray(c.rows))
          done.set(`${c.from}-${c.to}`, c.rows)
      } catch {
        /* a torn last line from a killed run: that chunk is re-scanned */
      }
    }
  const cacheBelow = Number(head ?? to) - SCAN_HEAD_MARGIN
  const chunks = []
  for (let a = from; a <= to; a += span) chunks.push([a, Math.min(to, a + span - 1)])
  const todo = chunks.filter(([a, b]) => !done.has(`${a}-${b}`))
  const wanted = new Set(topics0.map((t) => String(t).toLowerCase()))
  const unconfirmed = []
  let n = 0
  await pool(todo, concurrency, async ([a, b]) => {
    // Ankr caps the block range at 10k once a filter is too wide — addresses × topics (measured
    // 2026-10-06: 24 addresses × 43 topics × 250k blocks fine, 47 → "range exceeds limit of
    // 10000"; 2026-10-07: 20 × 72 fails, 10 × 72 and 20 × 43 pass), so wide address lists go out
    // in groups that keep addresses × topics under ~1,000.
    const per = Math.max(1, Math.min(20, Math.floor(1000 / Math.max(1, topics0.length))))
    const raw = []
    let error = null
    for (let g = 0; g < addresses.length; g += per) {
      try {
        const r = await crossCheckedLogs(p, sec, {
          address: addresses.slice(g, g + per),
          topics0,
          fromBlock: a,
          toBlock: b,
        })
        raw.push(...r.logs)
      } catch (e) {
        // lane T: the gap says which host failed and how (status / error class), never a URL.
        // A failure is a gap even when it describes as nothing (second review: an error whose
        // message starts with a newline described as "" and the chunk counted as confirmed).
        error = describeRpcError(e) || 'read failed (no error text)'
      }
    }
    const rows = []
    let undecodable = 0
    for (const l of raw) {
      if (l.removed) continue
      const d = decodeLog(l)
      if (!d) {
        // a log of an event this scan asked for that no declared ABI shape decodes: never dropped
        if (wanted.has(String(l.topics?.[0] ?? '').toLowerCase())) undecodable++
        continue
      }
      const row = {
        chainId,
        block: Number(BigInt(l.blockNumber)),
        logIndex: Number(BigInt(l.logIndex)),
        tx: l.transactionHash,
        emitter: l.address.toLowerCase(),
        event: d.event,
        args: d.args,
      }
      if (keep(row)) rows.push(row)
    }
    if (undecodable)
      error = [error, `${undecodable} requested log(s) not decodable`].filter(Boolean).join('; ')
    if (error) {
      unconfirmed.push({ scan, from: a, to: b, addresses: [...addresses], error })
      done.set(`${a}-${b}`, rows) // what WAS read is used this run — never cached
    } else {
      if (b <= cacheBelow)
        appendFileSync(
          file,
          JSON.stringify({ v: SCAN_CACHE_VERSION, confirmed: true, from: a, to: b, rows }) + '\n',
        )
      done.set(`${a}-${b}`, rows)
    }
    if (onProgress && ++n % 50 === 0) onProgress(n, todo.length)
  })
  if (unconfirmed.length) {
    if (!gaps)
      throw new Error(
        `${scan}: ${unconfirmed.length} chunk(s) not confirmed (${unconfirmed[0].from}–${unconfirmed[0].to}: ${unconfirmed[0].error})`,
      )
    gaps.push(...unconfirmed)
  }
  return chunks
    .flatMap(([a, b]) => done.get(`${a}-${b}`) ?? [])
    .sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)
}

/** Block timestamps for a set of blocks (cached in a JSON map under cacheDir). */
export async function blockTimestamps(client, blocks, cacheFile) {
  let cache = {}
  // fail-closed audit (ST-09): a cache that cannot be parsed is rebuilt (one torn write stopped
  // every later run), and it is written atomically
  if (cacheFile && existsSync(cacheFile))
    try {
      cache = JSON.parse(readFileSync(cacheFile, 'utf8'))
    } catch {
      cache = {}
    }
  const missing = [...new Set(blocks)].filter((b) => cache[b] === undefined)
  await pool(missing, 4, async (b) => {
    const blk = await retry(() => client.getBlock({ blockNumber: BigInt(b) }))
    const t = Number(blk?.timestamp)
    if (!Number.isFinite(t) || t <= 0) throw new Error(`block ${b}: no timestamp in the answer`)
    cache[b] = t
  })
  if (cacheFile && missing.length) writeJsonAtomic(cacheFile, cache)
  return cache
}

/**
 * True when a viem error is the CALL reverting (the contract answered "no"), false when the
 * read itself failed (transport, timeout, rate limit) — a failed read must never be taken as
 * a revert (fail closed: "not read", not "reverted").
 *
 * Fail-closed audit (RPC-REVERT, 2026-10-10): viem's getContractError turns ANY JSON-RPC error
 * with code -32603 ("Internal error", "upstream request timeout") into a
 * ContractFunctionRevertedError, and its node-error matcher builds an ExecutionRevertedError for
 * "gas required exceeds allowance". Both read as reverts: a route closed, a library "absent", a
 * simulation "stale". A revert is now: code 3, non-empty revert data, or an "execution reverted"
 * error that is NOT an internal error without data; a gas-cap / out-of-gas answer never is.
 */
export function isRevertError(e) {
  let named = false
  let internal = false
  let data = null
  for (let x = e, i = 0; x && i < 12; x = x.cause, i++) {
    const name = String(x.name ?? '')
    const text = `${x.details ?? ''}\n${x.shortMessage ?? ''}\n${x.message ?? ''}`
    if (/gas required exceeds allowance|out of gas/i.test(text)) return false
    if (/HttpRequestError|TimeoutError|WebSocketRequestError|LimitExceeded/.test(name)) return false
    const d = revertDataOf(x)
    if (d) data = d
    if (x.code === -32603 || /InternalRpcError/.test(name)) internal = true
    else if (x.code === 3) named = true
    if (/ContractFunctionRevertedError|ExecutionRevertedError|RawContractError/.test(name))
      named = true
    if (/execution reverted/i.test(String(x.details ?? x.shortMessage ?? ''))) named = true
  }
  if (data) return true
  if (internal) return false
  return named
}

/** Non-empty revert data (0x + at least a selector) carried by one error of a viem chain. */
function revertDataOf(x) {
  for (const v of [x.raw, x.data, x.data?.data])
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(v)) return v.toLowerCase()
  return null
}

/** The 4-byte selector of the revert data in a viem error chain (null = none carried). */
export function revertSelectorOf(e) {
  for (let x = e, i = 0; x && i < 12; x = x.cause, i++) {
    const d = revertDataOf(x)
    if (d) return d.slice(0, 10)
  }
  return null
}

/**
 * eth_call helper that never throws: { ok, value } | { ok: false, error, reverted, revertSelector }.
 * `revertSelector` (fail-closed audit LZ-05 / LZ-07): the custom error a revert carried, so a
 * caller can accept a revert as a FACT only when it is the error it expects.
 */
export async function tryRead(client, address, abi, functionName, args = [], blockNumber) {
  try {
    // lane T: a revert is answered once (deterministic); 429 / 5xx / timeouts back off
    const value = await retryRpc(() =>
      client.readContract({
        address,
        abi,
        functionName,
        args,
        blockNumber: blockNumber === undefined ? undefined : BigInt(blockNumber),
      }),
    )
    return { ok: true, value }
  } catch (e) {
    const reverted = isRevertError(e)
    return {
      ok: false,
      error: reverted
        ? scrub(e?.shortMessage || e?.message || e)
        : describeRpcError(e, { label: client?.rpcLabel, role: client?.rpcRole }),
      reverted,
      ...(reverted ? { revertSelector: revertSelectorOf(e) } : {}),
    }
  }
}

/**
 * Code at an address (null = no code). Fail-closed audit (CL-01): viem maps "0x" to undefined but
 * passes a JSON-RPC `null` through — a node that cannot serve the block. That is a FAILED read
 * (it throws), never "no code": a false EOA turned a downgrade into an upgrade, lowered the
 * weakest-holder bar and moved code bisections.
 */
export async function codeAt(client, address, blockNumber) {
  // lane T: the deploy-block bisection and its confirmation on the two log endpoints read here —
  // retried with backoff (`retryRpc`); the final error names the host label and the status
  let c
  try {
    c = await retryRpc(async () => {
      const x = await client.getCode({
        address,
        blockNumber: blockNumber === undefined ? undefined : BigInt(blockNumber),
      })
      if (x === null)
        throw Object.assign(new Error(`eth_getCode of ${address} answered null (not served)`), {
          rpcKind: 'unserved',
        })
      if (x !== undefined && typeof x !== 'string')
        throw Object.assign(new Error(`eth_getCode of ${address} answered a non-string`), {
          rpcKind: 'unserved',
        })
      return x
    })
  } catch (e) {
    throw rpcFailure(e, { client })
  }
  return c && c !== '0x' ? c : null
}
