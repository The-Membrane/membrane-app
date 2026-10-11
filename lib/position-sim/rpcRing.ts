/**
 * THE RPC RING — probe, save, cycle (owner 2026-09-23: "probe, save and cycle through
 * them so we don't overload a single one").
 *
 * Free endpoints differ in exactly one thing that matters to a log scan: the widest
 * `eth_getLogs` block range each will serve. Tonight (2026-09-23) the picture was
 * Pocket 10,000 · BlockPI 5,000 · nodies 50 · blastapi/1rpc 10 · everything else dead
 * or refusing — and it changes week to week. So the ring is not a hard-coded list:
 *   1. PROBE each candidate for its real getLogs cap (a topic-filtered call at
 *      10k/5k/2k/1k/800/500/100 blocks, first success wins) and its latency;
 *   2. SAVE the table to public/data/rpc-ring.json with a timestamp, so the next
 *      process (and the page) starts from measured facts, re-probing only when stale;
 *   3. CYCLE: every getLogs call rotates to the next endpoint whose cap covers the
 *      requested span, so no single free tier carries the whole job. A failure marks
 *      the endpoint cold for a cooldown; the ring keeps spinning on the rest.
 * Every other RPC method goes through viem's ordinary fallback over the live endpoints.
 *
 * AN EMPTY ANSWER IS NOT A FACT (2026-10-07). Measured against the Chainlink ETH/USD
 * AnswerUpdated scan: eth.api.pocket.network answers a 10,000-block query with `[]`
 * 10–15% of the time (8 of 55 calls) where Tenderly, MEV Blocker and BlockPI all return
 * the same 37–49 logs, and halving to 1,000 blocks does not help (2 of 20). A
 * rate-limited rpc.flashbots.net also answers `[]`. Neither is an error, so the old ring
 * took them as "no events here" — the 34–35 h holes in the price history. Now:
 *   - every EMPTY answer is re-asked on a second, INDEPENDENT endpoint (another backend,
 *     not another host of the same one) and believed only when both say empty;
 *   - an endpoint that said empty (or short) while another returned the logs is
 *     QUARANTINED for the run, and the fuller answer is kept;
 *   - an empty that no independent endpoint can check throws RingEmptyUnconfirmedError,
 *     so the halve-the-span ladders (here and in every caller) reach narrower spans,
 *     which more endpoints serve; at the floor it is flagged, never passed off as clean;
 *   - getLogsWideChecked returns the coverage (confidence: verified | unverified).
 * The probe had the same blind spot: it asked a RETIRED aggregator (ETH/USD phase 5)
 * over a window in which it emits nothing, so `[]` passed as proof of a 10k cap. It now
 * asks the live aggregator over a window that ENDS on a known log; an answer without
 * that log proves nothing.
 *
 * THE LEDGER (owner 2026-10-11: "an entry in our data that shows which RPC we are
 * getting things from so that we can evaluate them"). Every endpoint call is reported
 * to `onCall` as an RpcCall — host, block range, outcome, latency, and the piece's
 * verdict once reconciled, including whether another endpoint contradicted it. The
 * R33 audit proved 1,579 corpus events missing but could not say which endpoint
 * dropped them; a ledger row per call is what answers that next time. Ranges, not
 * events: a dropped event has no row of its own to tag. `spotCheckRate` re-asks a
 * fraction of NON-empty answers too, so short answers get a measured rate per host.
 * lib/position-sim/rpcScorecard.ts turns a ledger into per-endpoint rates.
 */
import { createPublicClient, fallback, http, parseAbiItem, type PublicClient, type Transport } from 'viem'
import { mainnet } from 'viem/chains'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export const CANDIDATES = [
  'https://eth.api.pocket.network',
  'https://ethereum.public.blockpi.network/v1/rpc/public',
  'https://eth.drpc.org',
  'https://ethereum-rpc.publicnode.com',
  'https://eth.llamarpc.com',
  'https://rpc.mevblocker.io',
  'https://rpc.flashbots.net/fast',
  'https://eth.merkle.io',
  'https://cloudflare-eth.com',
  'https://eth.api.onfinality.io/public',
  'https://mainnet.gateway.tenderly.co',
  'https://eth1.lava.build',
  'https://rpc.payload.de',
  'https://api.zan.top/eth-mainnet',
  'https://eth-pokt.nodies.app',
  'https://eth-mainnet.public.blastapi.io',
  'https://1rpc.io/eth',
]

export interface RingEntry {
  url: string
  /** Widest getLogs range that answered, in blocks. 0 = refused every size. */
  cap: number
  /** Latency of the successful probe call, ms. */
  ms: number
  /** Whether eth_blockNumber answered at all. */
  alive: boolean
  /** Probe answers that came back WITHOUT the anchor log — empty (or short) over a range
   *  known to hold it. Informational: the ring cross-checks every empty answer anyway.
   *  Absent in tables probed before 2026-10-07. */
  emptyAnswers?: number
}
export interface RingTable {
  probedAt: string
  entries: RingEntry[]
}

const PROBE_SIZES = [10_000n, 5_000n, 2_000n, 1_000n, 800n, 600n, 500n, 250n, 100n, 50n, 10n]
/** The probe window ENDS on a known log, so every probe size must return it: Chainlink
 *  ETH/USD phase-7 aggregator, round 5119, block 21,609,832, log 415. (The pre-2026-10-07
 *  probe asked phase 5, 0x37bC…a9e6, which emits nothing at 21.6M.) */
export const PROBE_AGG = '0x7d4e742018fb52e48b08be73d041c18b21de6fb5' as const
export const PROBE_ANCHOR_BLOCK = 21_609_832n
export const PROBE_ANCHOR_TX = '0xa7a23564357c9813da591112fb95d0a9bceefe9e5babdc5d1846ca713195a761'
const ANSWER_UPDATED = parseAbiItem(
  'event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)',
)
export const RING_PATH = join(process.cwd(), 'public', 'data', 'rpc-ring.json')
/** A saved table older than this is re-probed before use. */
export const RING_STALE_MS = 6 * 3600 * 1000

/** One transport per URL. Production uses viem's http; the unit tests inject a fake. */
export type TransportFor = (url: string, opts: { timeout: number; retryCount: number }) => Transport
const httpTransport: TransportFor = (url, opts) => http(url, opts)

export async function probeRing(
  candidates: string[] = CANDIDATES,
  extra: string[] = [],
  opts: { transportFor?: TransportFor; pauseMs?: number } = {},
): Promise<RingTable> {
  const transportFor = opts.transportFor ?? httpTransport
  const pauseMs = opts.pauseMs ?? 250
  const urls = [...new Set([...extra, ...candidates])]
  const entries = await Promise.all(
    urls.map(async (url): Promise<RingEntry> => {
      const c = createPublicClient({ chain: mainnet, transport: transportFor(url, { timeout: 12_000, retryCount: 0 }) })
      try {
        await c.getBlockNumber()
      } catch {
        return { url, cap: 0, ms: 0, alive: false }
      }
      let emptyAnswers = 0
      const flagged = () => (emptyAnswers ? { emptyAnswers } : {})
      for (const n of PROBE_SIZES) {
        // An answer without the anchor log gets one more try at the same size (Pocket's
        // empties are intermittent); an error is a refusal at this size.
        for (let tryNo = 0; tryNo < 2; tryNo++) {
          const t = Date.now()
          let refused = false
          try {
            const logs = await c.getLogs({
              address: PROBE_AGG,
              event: ANSWER_UPDATED,
              fromBlock: PROBE_ANCHOR_BLOCK - n + 1n,
              toBlock: PROBE_ANCHOR_BLOCK,
            })
            if (logs.some((l) => l.transactionHash?.toLowerCase() === PROBE_ANCHOR_TX)) {
              return { url, cap: Number(n), ms: Date.now() - t, alive: true, ...flagged() }
            }
            emptyAnswers++
          } catch {
            refused = true
          }
          // Pause briefly so a rate limit on one size does not zero the endpoint.
          await new Promise((r) => setTimeout(r, pauseMs))
          if (refused) break
        }
      }
      return { url, cap: 0, ms: 0, alive: true, ...flagged() }
    }),
  )
  entries.sort((a, b) => b.cap - a.cap || a.ms - b.ms)
  return { probedAt: new Date().toISOString(), entries }
}

/**
 * KEYS NEVER TOUCH DISK. A URL from RECORDER_RPC_URL (the keyed ones) is saved under the
 * alias `env:<host>` and re-resolved from RECORDER_RPC_URL at load time, so the table
 * under public/ (served by the app, tracked by git) holds only public hosts.
 */
const envUrls = (): string[] =>
  String(process.env.RECORDER_RPC_URL ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const aliasFor = (url: string): string => (envUrls().includes(url) ? `env:${new URL(url).host}` : url)
const resolveAlias = (u: string): string | null => {
  if (!u.startsWith('env:')) return u
  const host = u.slice(4)
  return envUrls().find((x) => new URL(x).host === host) ?? null
}

export function loadRing(): RingTable | null {
  try {
    const t = JSON.parse(readFileSync(RING_PATH, 'utf8')) as RingTable
    const entries = t.entries
      .map((e) => ({ ...e, url: resolveAlias(e.url) }))
      .filter((e): e is RingEntry => e.url !== null)
    return { ...t, entries }
  } catch {
    return null
  }
}
export function saveRing(t: RingTable): void {
  const redacted: RingTable = { ...t, entries: t.entries.map((e) => ({ ...e, url: aliasFor(e.url) })) }
  writeFileSync(RING_PATH, JSON.stringify(redacted, null, 2) + '\n')
}

/** Saved table if fresh, else probe + save. `extra` URLs (e.g. env) are probed too. */
export async function ensureRing(extra: string[] = [], maxAgeMs = RING_STALE_MS): Promise<RingTable> {
  const saved = loadRing()
  if (saved && Date.now() - Date.parse(saved.probedAt) < maxAgeMs && extra.every((u) => saved.entries.some((e) => e.url === u))) {
    return saved
  }
  const t = await probeRing(CANDIDATES, extra)
  saveRing(t)
  return t
}

/** Two hosts on one registrable domain answer from one fleet (gateway.tenderly.co and
 *  mainnet.gateway.tenderly.co), so they cannot confirm each other. Approximated by the
 *  last two DNS labels. Hosts only — a keyed URL's path never leaves this function. */
export function backendOf(url: string): string {
  return new URL(url).hostname.split('.').slice(-2).join('.')
}
const hostOf = (url: string): string => new URL(url).host
/** The ledger's name for an endpoint: its host, or `env:<host>` for a keyed URL from
 *  RECORDER_RPC_URL — the same alias rpc-ring.json uses — so a paid tier and the free
 *  tier of one provider stay apart. Never the path, which can hold a key. */
const ledgerHost = (url: string): string => (envUrls().includes(url) ? `env:${hostOf(url)}` : hostOf(url))
/** Error text with every URL cut to its host: viem puts the request URL in its messages,
 *  and a keyed URL carries its key in the path. */
export const redactUrls = (text: string): string =>
  text.replace(/https?:\/\/[^\s"'<>)]+/g, (u) => {
    try {
      return new URL(u).host
    } catch {
      return '<url>'
    }
  })

/** An empty answer that no independent endpoint could check. */
export class RingEmptyUnconfirmedError extends Error {
  constructor(
    readonly fromBlock: bigint,
    readonly toBlock: bigint,
    readonly host: string,
  ) {
    super(`rpc ring: ${host} answered [] for blocks ${fromBlock}-${toBlock} and no independent endpoint could confirm it`)
    this.name = 'RingEmptyUnconfirmedError'
  }
}

/** How far one getLogs answer can be trusted.
 *   agreed     — two independent endpoints returned the same logs (or both none);
 *   recovered  — they disagreed; the union was kept and the short side quarantined;
 *   single     — one non-empty answer, not re-asked (verify 'empty');
 *   unverified — nobody independent could check it (or verify 'none' and it was empty). */
export type PieceCheck = 'agreed' | 'recovered' | 'single' | 'unverified'
export interface CheckedLogs<T> {
  logs: T[]
  check: PieceCheck
  /** Host that gave the kept answer. */
  host: string
  /** Hosts quarantined by this call because their answer was missing logs. */
  contradicted?: string[]
}

/** What a wide scan can vouch for. `unverified` lists the ranges whose logs may be
 *  missing; a caller that publishes data from the scan should publish this too. */
export interface LogCoverage {
  fromBlock: bigint
  toBlock: bigint
  pieces: number
  /** Empty pieces two independent endpoints agreed on. */
  confirmedEmpty: number
  /** Pieces where one endpoint said empty (or short) and another returned logs. */
  recovered: { fromBlock: bigint; toBlock: bigint; host: string; logs: number }[]
  /** Pieces no independent endpoint could check. */
  unverified: { fromBlock: bigint; toBlock: bigint; host: string; logs: number }[]
  confidence: 'verified' | 'unverified'
}

export class RingCoverageError extends Error {
  constructor(readonly coverage: LogCoverage) {
    const r = coverage.unverified.slice(0, 3).map((u) => `${u.fromBlock}-${u.toBlock} (${u.host})`).join(', ')
    super(`rpc ring: ${coverage.unverified.length} unverified piece(s) in ${coverage.fromBlock}-${coverage.toBlock}: ${r}`)
    this.name = 'RingCoverageError'
  }
}

/** 'empty' (default): re-ask every empty answer on an independent endpoint.
 *  'all': re-ask every answer — catches a SHORT answer too, at twice the calls.
 *  'none': the pre-2026-10-07 ring; empties are still reported as unverified. */
export type VerifyMode = 'empty' | 'all' | 'none'
export interface RingOptions {
  /** How long a failed endpoint sits out. Default 20 s. */
  cooldownMs?: number
  verify?: VerifyMode
  /** How long an endpoint that contradicted another sits out. Default 6 h — the run. */
  quarantineMs?: number
  transportFor?: TransportFor
  /** verify 'empty' only: re-ask this fraction of NON-empty answers on an independent
   *  endpoint (role 'spot'). Measures short answers per host for ~rate extra calls. */
  spotCheckRate?: number
  /** Every endpoint call, after its piece is reconciled — the provenance ledger. */
  onCall?: (call: RpcCall) => void
  /** Test seam for the spot-check draw. */
  random?: () => number
}

/** One endpoint call in the ledger: who served which block range and how it checked
 *  out. HOSTS ONLY. An error keeps only its numeric code (JSON-RPC code or HTTP status):
 *  viem's error text carries the request URL, and a keyed URL carries its key. */
export interface RpcCall {
  /** ISO time the call started. */
  at: string
  /** Sequence number of the piece (one getLogsChecked), unique within the PROCESS (not
   *  per ring: one run can build several rings). With the writer's run id it groups the
   *  first answer, its errors and its second opinion into one piece. */
  piece: number
  /** Host, or `env:<host>` for a keyed RECORDER_RPC_URL endpoint. */
  host: string
  /** What was asked, from queryOf(): `<Event>@<addresses>`, `#filtered` if args narrowed it. */
  query: string
  fromBlock: bigint
  toBlock: bigint
  /** first — the ring's pick (errors included); recheck — an empty answer, or any answer
   *  under verify 'all', asked again; spot — a sampled re-ask of a non-empty answer. */
  role: 'first' | 'recheck' | 'spot'
  outcome: 'logs' | 'empty' | 'error'
  logs: number
  ms: number
  /** JSON-RPC code or HTTP status of an error; -1 is viem's code for an unknown error. */
  errorCode: number | null
  /** The piece's verdict once reconciled. 'failed': no endpoint answered at all. */
  verdict: PieceCheck | 'failed'
  /** This answer was missing logs that another endpoint returned. */
  contradicted: boolean
}

/** The ledger's name for a getLogs query. Public contract addresses and the event name
 *  only, so a ledger row can be grouped by what was asked. */
export function queryOf(args: { address?: unknown; event?: { name?: string }; events?: { name?: string }[]; args?: unknown }): string {
  const addr =
    args.address === undefined
      ? '*'
      : ([] as unknown[]).concat(args.address).map((a) => String(a).toLowerCase()).sort().join(',')
  const ev = args.event?.name ?? (args.events ? args.events.map((e) => e.name).join('|') : 'logs')
  return `${ev}@${addr}${args.args ? '#filtered' : ''}`
}

/** A numeric error code from a viem error chain, never its text. */
function errorCodeOf(err: unknown): number | null {
  let e = err as { code?: unknown; status?: unknown; cause?: unknown } | undefined
  for (let depth = 0; e && depth < 6; depth++) {
    if (typeof e.code === 'number') return e.code
    if (typeof e.status === 'number') return e.status
    e = e.cause as typeof e
  }
  return null
}

/**
 * The cycling client. `getLogs` picks the endpoint with the cheapest expected wait
 * whose cap covers the span; on failure the endpoint cools for `cooldownMs` and the
 * next is tried. Spans wider than the widest live cap are split into cap-sized pieces.
 */
export interface RingStat {
  host: string
  calls: number
  ok: number
  failed: number
  /** Answers that were `[]`. */
  empty: number
  /** Answers another endpoint proved were missing logs. */
  falseEmpty: number
  quarantined: boolean
  /** Blocks of getLogs range served successfully. */
  blocks: number
  /** Mean latency of successful calls, ms. */
  avgMs: number
}
/** Run totals of the cross-check. */
export interface RingChecks {
  /** Answers a second endpoint answered again. */
  rechecked: number
  /** Of those, non-empty answers sampled by spotCheckRate. */
  spotChecked: number
  confirmedEmpty: number
  recovered: number
  unverified: number
}

type Stat = { calls: number; ok: number; failed: number; empty: number; falseEmpty: number; blocks: number; ms: number }
type LogKey = { blockNumber?: bigint | number | null; logIndex?: number | bigint | null }
const keyOf = (l: unknown): string => {
  const x = l as LogKey
  return `${String(x.blockNumber)}:${String(x.logIndex)}`
}
const byPosition = (a: unknown, b: unknown): number => {
  const x = a as LogKey
  const y = b as LogKey
  const d = BigInt(x.blockNumber ?? 0) - BigInt(y.blockNumber ?? 0)
  return d !== 0n ? (d < 0n ? -1 : 1) : Number(x.logIndex ?? 0) - Number(y.logIndex ?? 0)
}

/** Process-wide, so (run, piece) stays unique when one run builds several rings. */
let pieceSeq = 0

export class RpcRing {
  private cold = new Map<string, number>()
  private quarantine = new Map<string, number>()
  private stat = new Map<string, Stat>()
  private totals: RingChecks = { rechecked: 0, spotChecked: 0, confirmedEmpty: 0, recovered: 0, unverified: 0 }
  private inflight = new Map<string, number>()
  private headAt: bigint | null = null
  private headSeen = 0
  /** Expected wait for one more call on `e`: its measured latency x (in-flight + 1). */
  private cost(e: RingEntry): number {
    const st = this.stat.get(e.url)
    const ms = Math.max(1, st && st.ok ? st.ms / st.ok : e.ms)
    return ms * ((this.inflight.get(e.url) ?? 0) + 1)
  }
  private clients = new Map<string, PublicClient>()
  readonly table: RingTable
  readonly minCap: number
  readonly verify: VerifyMode
  private readonly cooldownMs: number
  private readonly quarantineMs: number
  private readonly transportFor: TransportFor
  private readonly spotCheckRate: number
  private readonly onCall?: (call: RpcCall) => void
  private readonly random: () => number
  constructor(table: RingTable, opts: RingOptions | number = {}) {
    const o: RingOptions = typeof opts === 'number' ? { cooldownMs: opts } : opts
    this.cooldownMs = o.cooldownMs ?? 20_000
    this.quarantineMs = o.quarantineMs ?? RING_STALE_MS
    this.verify = o.verify ?? 'empty'
    this.transportFor = o.transportFor ?? httpTransport
    this.spotCheckRate = Math.min(1, Math.max(0, o.spotCheckRate ?? 0))
    this.onCall = o.onCall
    this.random = o.random ?? Math.random
    this.table = table
    const live = table.entries.filter((e) => e.cap > 0)
    if (live.length === 0) throw new Error('rpc ring: no endpoint serves eth_getLogs — re-probe or add a keyed RPC')
    this.minCap = Math.min(...live.map((e) => e.cap))
  }
  /** Endpoints that serve at least `span` blocks and are neither cooling nor quarantined. */
  private eligible(span: number): RingEntry[] {
    const now = Date.now()
    return this.table.entries.filter(
      (e) => e.cap >= span && (this.cold.get(e.url) ?? 0) < now && (this.quarantine.get(e.url) ?? 0) < now,
    )
  }
  private client(url: string): PublicClient {
    let c = this.clients.get(url)
    if (!c) {
      c = createPublicClient({ chain: mainnet, transport: this.transportFor(url, { timeout: 20_000, retryCount: 0 }) }) as PublicClient
      this.clients.set(url, c)
    }
    return c
  }
  private statFor(url: string): Stat {
    let st = this.stat.get(url)
    if (!st) {
      st = { calls: 0, ok: 0, failed: 0, empty: 0, falseEmpty: 0, blocks: 0, ms: 0 }
      this.stat.set(url, st)
    }
    return st
  }
  /** Widest span any live endpoint serves right now. */
  maxCap(): number {
    const e = this.eligible(1)
    return e.length ? Math.max(...e.map((x) => x.cap)) : 0
  }
  /** One raw answer from the cheapest eligible endpoint whose backend is not in `skip`.
   *  Errors cool the endpoint and move on; an empty answer is returned as-is. */
  private async ask<T>(
    args: { fromBlock: bigint; toBlock: bigint },
    skip: ReadonlySet<string>,
    role: RpcCall['role'],
    trail: RpcCall[],
    query: string,
    piece: number,
  ): Promise<{ ok: true; logs: T[]; url: string; call: RpcCall } | { ok: false; err: unknown }> {
    const span = Number(args.toBlock - args.fromBlock + 1n)
    let lastErr: unknown = null
    for (let attempt = 0; attempt < this.table.entries.length; attempt++) {
      const pool = this.eligible(span).filter((e) => !skip.has(backendOf(e.url)))
      if (pool.length === 0) break
      // Cheapest expected wait: measured latency x (in-flight + 1). A fast endpoint
      // takes the work until it is busy, then the next one; a failure still cools it
      // and the ring spins on. (Pure round-robin sent every 4th piece to a 1 s node.)
      const e = pool.reduce((best, x) => (this.cost(x) < this.cost(best) ? x : best), pool[0])
      const st = this.statFor(e.url)
      st.calls++
      this.inflight.set(e.url, (this.inflight.get(e.url) ?? 0) + 1)
      const t0 = Date.now()
      const call: RpcCall = {
        at: new Date(t0).toISOString(),
        piece,
        host: ledgerHost(e.url),
        query,
        fromBlock: args.fromBlock,
        toBlock: args.toBlock,
        role,
        outcome: 'error',
        logs: 0,
        ms: 0,
        errorCode: null,
        verdict: 'failed',
        contradicted: false,
      }
      trail.push(call)
      try {
        const r = (await this.client(e.url).getLogs(args as any)) as T[]
        st.ok++
        st.blocks += span
        st.ms += Date.now() - t0
        if (r.length === 0) st.empty++
        call.outcome = r.length === 0 ? 'empty' : 'logs'
        call.logs = r.length
        call.ms = Date.now() - t0
        return { ok: true, logs: r, url: e.url, call }
      } catch (err) {
        st.failed++
        lastErr = err
        call.ms = Date.now() - t0
        call.errorCode = errorCodeOf(err)
        this.cold.set(e.url, Date.now() + this.cooldownMs)
      } finally {
        this.inflight.set(e.url, (this.inflight.get(e.url) ?? 1) - 1)
      }
    }
    return { ok: false, err: lastErr }
  }
  private strike(url: string): void {
    this.statFor(url).falseEmpty++
    this.quarantine.set(url, Date.now() + this.quarantineMs)
  }
  /**
   * One getLogs over [from, to] and how far its answer can be trusted. An empty answer
   * (every answer, under verify 'all') is re-asked on an independent backend. A real log
   * cannot be invented by an honest node, so when the two disagree the UNION is kept and
   * each side that was missing logs is quarantined.
   */
  async getLogsChecked<T>(args: Parameters<PublicClient['getLogs']>[0] & { fromBlock: bigint; toBlock: bigint }): Promise<CheckedLogs<T>> {
    const trail: RpcCall[] = []
    const query = queryOf(args as Parameters<typeof queryOf>[0])
    const piece = ++pieceSeq
    // Every call of this piece goes to the ledger with the piece's final verdict.
    const settle = (verdict: RpcCall['verdict']): void => {
      for (const c of trail) {
        c.verdict = verdict
        this.onCall?.(c)
      }
    }
    const span = Number(args.toBlock - args.fromBlock + 1n)
    const first = await this.ask<T>(args, new Set(), 'first', trail, query, piece)
    if (!first.ok) {
      settle('failed')
      throw new Error(`rpc ring: no endpoint served getLogs over ${span} blocks: ${redactUrls(String(first.err)).slice(0, 160)}`)
    }
    const empty = first.logs.length === 0
    const spot = this.verify === 'empty' && !empty && this.spotCheckRate > 0 && this.random() < this.spotCheckRate
    if (this.verify === 'none' || (this.verify === 'empty' && !empty && !spot)) {
      if (empty) this.totals.unverified++
      settle(empty ? 'unverified' : 'single')
      return { logs: first.logs, check: empty ? 'unverified' : 'single', host: hostOf(first.url) }
    }
    const second = await this.ask<T>(args, new Set([backendOf(first.url)]), spot ? 'spot' : 'recheck', trail, query, piece)
    if (!second.ok) {
      // A spot-check is a sample: finding no second endpoint free is no evidence either
      // way, so the answer stays an ordinary unchecked one. A required re-ask that finds
      // nobody leaves the piece unverified.
      if (spot) {
        settle('single')
        return { logs: first.logs, check: 'single', host: hostOf(first.url) }
      }
      this.totals.unverified++
      settle('unverified')
      return { logs: first.logs, check: 'unverified', host: hostOf(first.url) }
    }
    this.totals.rechecked++
    if (spot) this.totals.spotChecked++
    const a = new Set(first.logs.map(keyOf))
    const b = new Set(second.logs.map(keyOf))
    const aShort = [...b].some((k) => !a.has(k))
    const bShort = [...a].some((k) => !b.has(k))
    if (!aShort && !bShort) {
      if (empty) this.totals.confirmedEmpty++
      settle('agreed')
      return { logs: first.logs, check: 'agreed', host: hostOf(first.url) }
    }
    const union = new Map<string, T>()
    for (const l of [...first.logs, ...second.logs]) if (!union.has(keyOf(l))) union.set(keyOf(l), l)
    const contradicted: string[] = []
    if (aShort) {
      this.strike(first.url)
      first.call.contradicted = true
      contradicted.push(hostOf(first.url))
    }
    if (bShort) {
      this.strike(second.url)
      second.call.contradicted = true
      contradicted.push(hostOf(second.url))
    }
    this.totals.recovered++
    settle('recovered')
    const kept = second.logs.length > first.logs.length ? second.url : first.url
    return { logs: [...union.values()].sort(byPosition), check: 'recovered', host: hostOf(kept), contradicted }
  }
  /** One getLogs over [from, to], rotated across every endpoint that can serve it. Throws
   *  RingEmptyUnconfirmedError for an empty answer nobody independent could check. */
  async getLogs<T>(args: Parameters<PublicClient['getLogs']>[0] & { fromBlock: bigint; toBlock: bigint }): Promise<T[]> {
    const r = await this.getLogsChecked<T>(args)
    if (r.check === 'unverified' && r.logs.length === 0 && this.verify !== 'none') {
      throw new RingEmptyUnconfirmedError(args.fromBlock, args.toBlock, r.host)
    }
    return r.logs
  }
  /** getLogs over any range, split into pieces no wider than the ring can serve. Throws
   *  RingCoverageError if any piece stayed unverified — use getLogsWideChecked to keep
   *  the logs and read the coverage instead. */
  async getLogsWide<T>(args: Parameters<PublicClient['getLogs']>[0] & { fromBlock: bigint; toBlock: bigint }, concurrency = 1): Promise<T[]> {
    const { logs, coverage } = await this.getLogsWideChecked<T>(args, concurrency)
    if (coverage.confidence === 'unverified' && this.verify !== 'none') throw new RingCoverageError(coverage)
    return logs
  }
  /** getLogsWide plus what the scan can vouch for. `concurrency` > 1 runs cap-sized
   *  pieces in parallel (each piece still has the halving/cooldown fallback of the
   *  sequential path). Order of the result is by piece. */
  async getLogsWideChecked<T>(
    args: Parameters<PublicClient['getLogs']>[0] & { fromBlock: bigint; toBlock: bigint },
    concurrency = 1,
  ): Promise<{ logs: T[]; coverage: LogCoverage }> {
    // A range past the chain head is an invalid-params error on every endpoint (Ankr:
    // "block range extends beyond current head block"), and the halving fallback then
    // burns the whole ladder for nothing — an episode window that runs 72h past a
    // liquidation from yesterday does exactly that. Clamp to head (cached ~60 s).
    if (args.toBlock > (this.headAt ?? 0n) || Date.now() - this.headSeen > 60_000) {
      if (args.toBlock > (this.headAt ?? 0n)) {
        this.headAt = await this.readClient().getBlockNumber()
        this.headSeen = Date.now()
      }
    }
    const cov: LogCoverage = {
      fromBlock: args.fromBlock,
      toBlock: args.toBlock,
      pieces: 0,
      confirmedEmpty: 0,
      recovered: [],
      unverified: [],
      confidence: 'verified',
    }
    if (this.headAt !== null && args.toBlock > this.headAt) {
      if (args.fromBlock > this.headAt) return { logs: [], coverage: cov }
      args = { ...args, toBlock: this.headAt }
      cov.toBlock = this.headAt
    }
    const logs = await this.wide<T>(args, concurrency, cov)
    cov.confidence = cov.unverified.length ? 'unverified' : 'verified'
    return { logs, coverage: cov }
  }
  private async wide<T>(
    args: Parameters<PublicClient['getLogs']>[0] & { fromBlock: bigint; toBlock: bigint },
    concurrency: number,
    cov: LogCoverage,
  ): Promise<T[]> {
    if (concurrency > 1) {
      const cap = BigInt(Math.max(this.maxCap(), this.minCap))
      const pieces: { fromBlock: bigint; toBlock: bigint }[] = []
      for (let c = args.fromBlock; c <= args.toBlock; c += cap) {
        pieces.push({ fromBlock: c, toBlock: c + cap - 1n < args.toBlock ? c + cap - 1n : args.toBlock })
      }
      const results: T[][] = new Array(pieces.length)
      let next = 0
      const worker = async () => {
        for (;;) {
          const i = next++
          if (i >= pieces.length) return
          results[i] = await this.wide<T>({ ...args, ...pieces[i] }, 1, cov)
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, pieces.length) }, worker))
      return results.flat()
    }
    const out: T[] = []
    let cursor = args.fromBlock
    // Start at the widest live cap; on a failure halve the piece (a narrower piece
    // is eligible on more endpoints) down to the smallest live cap, then wait out
    // one cooldown and try the floor once more before giving up. An unconfirmed empty
    // takes the same ladder — narrower pieces are what a second endpoint can check —
    // and once a piece survives, the span climbs back so one bad piece does not slow
    // the rest of the range.
    const start = BigInt(Math.max(this.maxCap(), this.minCap))
    let span = start
    const floor = BigInt(this.minCap)
    let waited = false
    while (cursor <= args.toBlock) {
      const to = cursor + span - 1n < args.toBlock ? cursor + span - 1n : args.toBlock
      try {
        const r = await this.getLogsChecked<T>({ ...args, fromBlock: cursor, toBlock: to })
        if (r.check === 'unverified' && r.logs.length === 0 && this.verify !== 'none') {
          throw new RingEmptyUnconfirmedError(cursor, to, r.host)
        }
        cov.pieces++
        if (r.check === 'agreed' && r.logs.length === 0) cov.confirmedEmpty++
        if (r.check === 'recovered') cov.recovered.push({ fromBlock: cursor, toBlock: to, host: (r.contradicted ?? []).join('+'), logs: r.logs.length })
        if (r.check === 'unverified') cov.unverified.push({ fromBlock: cursor, toBlock: to, host: r.host, logs: r.logs.length })
        out.push(...r.logs)
        cursor = to + 1n
        waited = false
        if (span < start) span = span * 2n < start ? span * 2n : start
      } catch (err) {
        if (span > floor) {
          span = span / 2n > floor ? span / 2n : floor
          continue
        }
        if (!waited) {
          waited = true
          await new Promise((r) => setTimeout(r, this.cooldownMs + 500))
          continue
        }
        if (err instanceof RingEmptyUnconfirmedError) {
          // Nothing independent serves this range even at the floor. Keep going, and
          // say so: the piece is in the coverage as unverified, never as clean.
          cov.pieces++
          cov.unverified.push({ fromBlock: cursor, toBlock: to, host: err.host, logs: 0 })
          cursor = to + 1n
          waited = false
          continue
        }
        throw err
      }
    }
    return out
  }
  /**
   * Who actually carried the work (owner 2026-09-23: "track which ones work the best
   * for us so I know what I want to actually pay for"). Hosts only — never keys.
   */
  stats(): RingStat[] {
    const now = Date.now()
    return [...this.stat.entries()]
      .map(([url, s]) => ({
        host: hostOf(url),
        calls: s.calls,
        ok: s.ok,
        failed: s.failed,
        empty: s.empty,
        falseEmpty: s.falseEmpty,
        quarantined: (this.quarantine.get(url) ?? 0) > now,
        blocks: s.blocks,
        avgMs: s.ok ? Math.round(s.ms / s.ok) : 0,
      }))
      .sort((a, b) => b.blocks - a.blocks)
  }
  /** Run totals of the empty-answer cross-check. */
  checks(): RingChecks {
    return { ...this.totals }
  }
  /** Append this run's stats to public/data/rpc-ring-stats.json (hosts only). */
  saveStats(runLabel: string): void {
    const path = join(process.cwd(), 'public', 'data', 'rpc-ring-stats.json')
    let prev: { runs: { run: string; at: string; stats: RingStat[]; checks?: RingChecks }[] } = { runs: [] }
    try {
      prev = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      /* first run */
    }
    const runs = prev.runs.filter((r) => r.run !== runLabel)
    runs.push({ run: runLabel, at: new Date().toISOString(), stats: this.stats(), checks: this.checks() })
    writeFileSync(path, JSON.stringify({ runs }, null, 2) + '\n')
  }
  /** A plain viem client over the live endpoints for every non-getLogs call. */
  readClient(): PublicClient {
    const live = this.table.entries.filter((e) => e.alive)
    return createPublicClient({
      chain: mainnet,
      transport: fallback(live.map((e) => this.transportFor(e.url, { timeout: 20_000, retryCount: 1 })), { rank: false, retryCount: 1 }),
    }) as PublicClient
  }
}
