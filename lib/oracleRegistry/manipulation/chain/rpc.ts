/**
 * JSON-RPC reader for the manipulation engine. Server/script side only.
 *
 * Dependency-free (plain fetch, no packages) so the build and the fork tests run from
 * a bare checkout. Its only import outside this folder is
 * lib/position-sim/rpcExclusions, which itself imports nothing. Three things the rest
 * of the engine relies on:
 *
 *  1. ENDPOINTS: RECORDER_RPC_URL (comma list, from the env or .env.local), then
 *     keyless public archive endpoints. An env URL is only ever shown as
 *     `env:<host>`. Its value is never logged, stored or put in an error. The builder
 *     relays (rpc.flashbots.net, rpc.mevblocker.io) are dropped from the env list:
 *     see rpcExclusions (board R33, 2026-10-11).
 *  2. MULTICALL: `multicall()` folds view calls into Multicall3.aggregate3 at one
 *     block, with per-call failure allowed, so a 2,000-market enumeration is ~20
 *     eth_calls.
 *  3. LOGS WITH A SECOND OPINION: `getLogsWide()` splits a range into capped chunks.
 *     Free endpoints sometimes answer a chunk with `[]` when logs exist (owner
 *     2026-10-05: "the shared rpcRing getLogsWide can return false-empty chunks").
 *     Every empty chunk is re-asked of a DIFFERENT endpoint. A non-empty second
 *     answer wins and is counted as a false-empty in the provenance.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { withoutExcludedLogHosts } from '../../../position-sim/rpcExclusions'
import { decodeAbi, encodeAbi, type Fn, type Hex, type AbiValue } from './abi'

export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'

/** Keyless endpoints that served archive eth_call on 2026-10-07 (probed this session). */
export const PUBLIC_CALL_RPCS = [
  'https://eth.drpc.org',
  'https://gateway.tenderly.co/public/mainnet',
  'https://mainnet.gateway.tenderly.co',
] as const

/** Keyless endpoints that served a 2,000-block topic-filtered getLogs on 2026-10-07.
 *  rpc.mevblocker.io is gone: it was dead at every probe on 2026-10-11 (board R33). */
export const PUBLIC_LOG_RPCS = [
  { url: 'https://gateway.tenderly.co/public/mainnet', cap: 10_000 },
  { url: 'https://eth.api.pocket.network', cap: 10_000 },
  { url: 'https://mainnet.gateway.tenderly.co', cap: 10_000 },
  { url: 'https://ethereum.public.blockpi.network/v1/rpc/public', cap: 5_000 },
] as const

function envValue(key: string): string | undefined {
  if (process.env[key]) return process.env[key]
  try {
    const env = readFileSync(join(process.cwd(), '.env.local'), 'utf8')
    return (env.match(new RegExp(`^${key}=(.*)$`, 'm')) || [])[1]?.trim().replace(/^["']|["']$/g, '') || undefined
  } catch {
    return undefined
  }
}

/** RECORDER_RPC_URL as a list, without the builder relays: remote copies of it still
 *  name them, and Flashbots answers `[]` outside the slice of history it serves. */
export function envRpcUrls(): string[] {
  return withoutExcludedLogHosts(
    String(envValue('RECORDER_RPC_URL') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

const hostOf = (u: string): string => {
  try {
    return new URL(u).host
  } catch {
    return 'invalid-url'
  }
}

/** First line of an error with every URL removed (viem-style endpoints can carry keys). */
export function redact(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return (msg.split('\n')[0] ?? '').replace(/https?:\/\/\S+/g, '[rpc]').slice(0, 240)
}

export type BlockTag = bigint | 'latest'
const tag = (b: BlockTag): string => (b === 'latest' ? 'latest' : `0x${b.toString(16)}`)

export interface Log {
  address: string
  topics: Hex[]
  data: Hex
  blockNumber: bigint
  transactionHash: Hex
  logIndex: number
}

export interface LogsProvenance {
  chunks: number
  emptyChunks: number
  crossChecked: number
  /** Chunks where the first endpoint said `[]` and the second returned logs. */
  falseEmpty: number
  /** Empty chunks no second endpoint could confirm (only one endpoint answered). */
  unconfirmedEmpty: number
  hosts: string[]
}

interface Endpoint {
  url: string
  label: string
  /** Widest getLogs span this endpoint serves (0 = do not use for logs). */
  logCap: number
  archive: boolean
  coldUntil: number
  calls: number
  failures: number
}

// No TS parameter properties anywhere in this module tree: the engine must run under
// Node's strip-only type erasure as well as tsx/vitest.
class RpcError extends Error {
  readonly code: number | null
  readonly data: string | null
  constructor(message: string, code: number | null, data: string | null) {
    super(message)
    this.code = code
    this.data = data
  }
}

/** A revert (the call ran and failed), as opposed to a transport failure. */
const isRevert = (e: unknown): boolean =>
  e instanceof RpcError &&
  (e.code === 3 || /revert|execution reverted|invalid opcode|out of gas/i.test(e.message)) &&
  !/archive|state|header not found|missing trie/i.test(e.message)

const isNoArchive = (e: unknown): boolean =>
  e instanceof Error && /archive|personal token|missing trie node|header not found|Unknown state|pruned/i.test(e.message)

export interface RpcOptions {
  callUrls?: string[]
  logUrls?: { url: string; cap: number }[]
  timeoutMs?: number
  /** Max in-flight requests per endpoint. */
  perEndpoint?: number
  cooldownMs?: number
}

export class Rpc {
  private eps: Endpoint[]
  private inflight = new Map<string, number>()
  private timeoutMs: number
  private perEndpoint: number
  private cooldownMs: number
  private rr = 0
  private id = 1
  readonly falseEmptyEvents: { from: bigint; to: bigint; firstHost: string; secondHost: string }[] = []

  constructor(opts: RpcOptions = {}) {
    const env = envRpcUrls()
    const callUrls = opts.callUrls ?? [...env, ...PUBLIC_CALL_RPCS.filter((u) => !env.includes(u))]
    const logUrls = opts.logUrls ?? [...env.map((url) => ({ url, cap: 10_000 })), ...PUBLIC_LOG_RPCS]
    const byUrl = new Map<string, Endpoint>()
    const label = (u: string) => (env.includes(u) ? `env:${hostOf(u)}` : hostOf(u))
    for (const url of callUrls) {
      byUrl.set(url, { url, label: label(url), logCap: 0, archive: true, coldUntil: 0, calls: 0, failures: 0 })
    }
    for (const { url, cap } of logUrls) {
      const e = byUrl.get(url)
      if (e) e.logCap = cap
      else byUrl.set(url, { url, label: label(url), logCap: cap, archive: false, coldUntil: 0, calls: 0, failures: 0 })
    }
    this.eps = [...byUrl.values()]
    if (this.eps.length === 0) throw new Error('rpc: no endpoints')
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.perEndpoint = opts.perEndpoint ?? 4
    this.cooldownMs = opts.cooldownMs ?? 15_000
  }

  /** Hosts only, for provenance. Never URLs. */
  labels(): string[] {
    return this.eps.map((e) => e.label)
  }

  stats(): { host: string; calls: number; failures: number }[] {
    return this.eps.map((e) => ({ host: e.label, calls: e.calls, failures: e.failures }))
  }

  private async post(ep: Endpoint, method: string, params: unknown[]): Promise<unknown> {
    const n = this.inflight.get(ep.url) ?? 0
    this.inflight.set(ep.url, n + 1)
    ep.calls++
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs)
    try {
      const res = await fetch(ep.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.id++, method, params }),
        signal: ctl.signal,
      })
      const text = await res.text()
      if (res.status === 429) throw new RpcError(`http 429 rate limited`, 429, null)
      let body: { result?: unknown; error?: { code?: number; message?: string; data?: unknown } }
      try {
        body = JSON.parse(text)
      } catch {
        throw new RpcError(`http ${res.status}: non-JSON reply`, res.status, null)
      }
      if (body.error) {
        const d = body.error.data
        throw new RpcError(
          String(body.error.message ?? 'rpc error'),
          typeof body.error.code === 'number' ? body.error.code : null,
          typeof d === 'string' ? d : d && typeof d === 'object' && 'data' in d ? String((d as { data: unknown }).data) : null,
        )
      }
      return body.result
    } catch (e) {
      if (e instanceof RpcError) throw e
      throw new RpcError(redact(e), null, null)
    } finally {
      clearTimeout(timer)
      this.inflight.set(ep.url, (this.inflight.get(ep.url) ?? 1) - 1)
    }
  }

  private pick(filter: (e: Endpoint) => boolean, exclude: Set<string>): Endpoint | null {
    const now = Date.now()
    const pool = this.eps.filter((e) => filter(e) && !exclude.has(e.url) && e.coldUntil < now)
    if (pool.length === 0) return null
    // Least in-flight first, round-robin among ties.
    const minLoad = Math.min(...pool.map((e) => this.inflight.get(e.url) ?? 0))
    const ties = pool.filter((e) => (this.inflight.get(e.url) ?? 0) === minLoad)
    return ties[this.rr++ % ties.length]
  }

  private async waitSlot(ep: Endpoint): Promise<void> {
    while ((this.inflight.get(ep.url) ?? 0) >= this.perEndpoint) await new Promise((r) => setTimeout(r, 25))
  }

  /**
   * Send one request with failover. A revert is returned to the caller at once (it is
   * an answer, not an endpoint failure). Everything else cools the endpoint and moves on.
   */
  async request(method: string, params: unknown[], opts: { historical?: boolean; logSpan?: number } = {}): Promise<unknown> {
    const tried = new Set<string>()
    let lastErr: unknown = null
    for (let round = 0; round < 3; round++) {
      for (;;) {
        const ep = this.pick(
          (e) => (opts.logSpan !== undefined ? e.logCap >= opts.logSpan : e.archive || !opts.historical),
          tried,
        )
        if (!ep) break
        tried.add(ep.url)
        await this.waitSlot(ep)
        try {
          return await this.post(ep, method, params)
        } catch (e) {
          if (isRevert(e)) throw e
          lastErr = e
          ep.failures++
          if (opts.historical && isNoArchive(e) && opts.logSpan === undefined) ep.archive = false
          ep.coldUntil = Date.now() + this.cooldownMs
        }
      }
      tried.clear()
      await new Promise((r) => setTimeout(r, 1500 * (round + 1)))
    }
    throw new Error(`rpc ${method}: every endpoint failed: ${redact(lastErr)}`)
  }

  async blockNumber(): Promise<bigint> {
    return BigInt(String(await this.request('eth_blockNumber', [])))
  }

  async block(b: BlockTag): Promise<{ number: bigint; timestamp: bigint }> {
    const r = (await this.request('eth_getBlockByNumber', [tag(b), false], { historical: b !== 'latest' })) as {
      number: string
      timestamp: string
    }
    return { number: BigInt(r.number), timestamp: BigInt(r.timestamp) }
  }

  async code(addr: string, b: BlockTag = 'latest'): Promise<Hex> {
    return (await this.request('eth_getCode', [addr, tag(b)], { historical: b !== 'latest' })) as Hex
  }

  async storageAt(addr: string, slot: Hex, b: BlockTag = 'latest'): Promise<Hex> {
    return (await this.request('eth_getStorageAt', [addr, slot, tag(b)], { historical: b !== 'latest' })) as Hex
  }

  /** Raw eth_call. Throws on revert. */
  async callRaw(to: string, data: Hex, b: BlockTag = 'latest', overrides?: Record<string, unknown>): Promise<Hex> {
    const params: unknown[] = [{ to, data }, tag(b)]
    if (overrides) params.push(overrides)
    return (await this.request('eth_call', params, { historical: b !== 'latest' })) as Hex
  }

  async call(to: string, f: Fn, args: AbiValue[] = [], b: BlockTag = 'latest'): Promise<AbiValue> {
    return f.decode(await this.callRaw(to, f.encode(args), b))
  }

  /** Like `call` but `null` on revert or on undecodable return data. */
  async tryCall(to: string, f: Fn, args: AbiValue[] = [], b: BlockTag = 'latest'): Promise<AbiValue | null> {
    try {
      const ret = await this.callRaw(to, f.encode(args), b)
      if (ret === '0x') return null
      return f.decode(ret)
    } catch (e) {
      if (isRevert(e) || /abi:/.test(String((e as Error)?.message))) return null
      throw e
    }
  }

  /**
   * Batch view calls through Multicall3.aggregate3 (allowFailure on each). A failed or
   * undecodable call comes back as `null`. Chunks of `chunk` calls run in parallel.
   */
  async multicall(
    calls: { target: string; fn: Fn; args?: AbiValue[] }[],
    b: BlockTag = 'latest',
    chunk = 150,
  ): Promise<(AbiValue | null)[]> {
    const out: (AbiValue | null)[] = new Array(calls.length).fill(null)
    const pieces: number[][] = []
    for (let i = 0; i < calls.length; i += chunk) pieces.push(Array.from({ length: Math.min(chunk, calls.length - i) }, (_, k) => i + k))
    await Promise.all(
      pieces.map(async (idx) => {
        const data = encodeAbi('(address,bool,bytes)[]', [idx.map((i) => [calls[i].target, true, calls[i].fn.encode(calls[i].args ?? [])])])
        const ret = await this.callRaw(MULTICALL3, (`0x82ad56cb${data.slice(2)}` as Hex), b)
        const [results] = decodeAbi('(bool,bytes)[]', ret) as [[boolean, Hex][]]
        results.forEach(([ok, bytes], k) => {
          if (!ok || bytes === '0x') return
          try {
            out[idx[k]] = calls[idx[k]].fn.decode(bytes)
          } catch {
            out[idx[k]] = null
          }
        })
      }),
    )
    return out
  }

  private async logsOnce(
    filter: { address?: string | string[]; topics?: (Hex | Hex[] | null)[] },
    from: bigint,
    to: bigint,
    exclude: Set<string>,
  ): Promise<{ logs: Log[]; host: string }> {
    const span = Number(to - from + 1n)
    let lastErr: unknown = null
    for (;;) {
      const ep = this.pick((e) => e.logCap >= span, exclude)
      if (!ep) break
      exclude.add(ep.url)
      await this.waitSlot(ep)
      try {
        const raw = (await this.post(ep, 'eth_getLogs', [{ ...filter, fromBlock: tag(from), toBlock: tag(to) }])) as {
          address: string
          topics: Hex[]
          data: Hex
          blockNumber: string
          transactionHash: Hex
          logIndex: string
        }[]
        if (!Array.isArray(raw)) throw new Error('getLogs: non-array result')
        return {
          host: ep.label,
          logs: raw.map((l) => ({
            address: l.address.toLowerCase(),
            topics: l.topics,
            data: l.data,
            blockNumber: BigInt(l.blockNumber),
            transactionHash: l.transactionHash,
            logIndex: Number(l.logIndex),
          })),
        }
      } catch (e) {
        lastErr = e
        ep.failures++
        ep.coldUntil = Date.now() + this.cooldownMs
      }
    }
    throw new Error(`getLogs ${from}-${to}: no endpoint served it: ${redact(lastErr)}`)
  }

  /**
   * getLogs over any range. Empty chunks are cross-checked on a second endpoint.
   * `chunkSize` defaults to the widest cap of a live log endpoint, max 10,000.
   */
  async getLogsWide(
    filter: { address?: string | string[]; topics?: (Hex | Hex[] | null)[] },
    fromBlock: bigint,
    toBlock: bigint,
    opts: { chunkSize?: number; concurrency?: number; crossCheckEmpty?: boolean } = {},
  ): Promise<{ logs: Log[]; provenance: LogsProvenance }> {
    const caps = this.eps.map((e) => e.logCap).filter((c) => c > 0)
    if (caps.length === 0) throw new Error('getLogsWide: no log endpoints')
    const size = BigInt(opts.chunkSize ?? Math.min(10_000, Math.max(...caps)))
    const pieces: [bigint, bigint][] = []
    for (let c = fromBlock; c <= toBlock; c += size) pieces.push([c, c + size - 1n < toBlock ? c + size - 1n : toBlock])
    const prov: LogsProvenance = { chunks: pieces.length, emptyChunks: 0, crossChecked: 0, falseEmpty: 0, unconfirmedEmpty: 0, hosts: [] }
    const hosts = new Set<string>()
    const results: Log[][] = new Array(pieces.length)
    let next = 0
    const crossCheck = opts.crossCheckEmpty ?? true
    const fetchPiece = async (from: bigint, to: bigint): Promise<Log[]> => {
      try {
        const first = await this.logsOnce(filter, from, to, new Set())
        hosts.add(first.host)
        if (first.logs.length > 0 || !crossCheck) return first.logs
        prov.emptyChunks++
        const firstUrl = this.eps.find((e) => e.label === first.host)?.url
        try {
          const second = await this.logsOnce(filter, from, to, new Set(firstUrl ? [firstUrl] : []))
          prov.crossChecked++
          hosts.add(second.host)
          if (second.logs.length > 0) {
            prov.falseEmpty++
            this.falseEmptyEvents.push({ from, to, firstHost: first.host, secondHost: second.host })
          }
          return second.logs
        } catch {
          prov.unconfirmedEmpty++
          return []
        }
      } catch (e) {
        // A chunk too wide for every live endpoint: split it.
        if (to > from && /no endpoint served/.test(String((e as Error).message))) {
          const mid = from + (to - from) / 2n
          return [...(await fetchPiece(from, mid)), ...(await fetchPiece(mid + 1n, to))]
        }
        throw e
      }
    }
    const worker = async () => {
      for (;;) {
        const i = next++
        if (i >= pieces.length) return
        results[i] = await fetchPiece(pieces[i][0], pieces[i][1])
      }
    }
    await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 6, pieces.length) }, worker))
    prov.hosts = [...hosts]
    const logs = results.flat()
    logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))
    return { logs, provenance: prov }
  }
}

let shared: Rpc | null = null
export function sharedRpc(): Rpc {
  if (!shared) shared = new Rpc()
  return shared
}
