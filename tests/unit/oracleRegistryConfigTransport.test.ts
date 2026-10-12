// Config cards — lane T (2026-10-11): the TRANSPORT of the collector's reads. The first CI run
// lost 204 scan chunks to "HTTP request failed." from the cross-check log endpoint (unpaced,
// two tries 400 / 800 ms apart, the gap text without host or status), one failed chunk stopped
// the whole LDO holder stream, failed deploy-block confirmations were log lines only, and the
// token-vote log line counted classifications whose holder snapshots had all errored.
//
// Every test here uses only the collector API that existed before lane T, through the real viem
// transport (`ethereumClients()` over a stubbed `fetch`), so each one also runs against the code
// before the fix: every test failed there unless it is marked (control). No verdict changes: a
// read that still fails is the same gap it was — only paced, retried and described.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { keccak256, pad, toHex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { enrichTokenVotes } from '@/scripts/oracle-registry/config/lib/admin.mjs'
import { applyTransfer, holderSnapshots } from '@/scripts/oracle-registry/config/lib/holders.mjs'
import { firstCodeBlocks } from '@/scripts/oracle-registry/config/lib/lz.mjs'
import {
  crossCheckedLogs as crossCheckedLogsJs,
  ethereumClients,
  scanLogs,
} from '@/scripts/oracle-registry/config/lib/rpc.mjs'

// the collector is JavaScript: its inferred types are narrowed here
const crossCheckedLogs = crossCheckedLogsJs as unknown as (
  p: unknown,
  s: unknown,
  q: Record<string, unknown>,
) => Promise<{ logs: unknown[]; corrected: boolean }>

type Hx = `0x${string}`
const A = (n: string) => ('0x' + n.repeat(40).slice(0, 40)) as Hx
const X = A('1')
const TOPIC = keccak256(toHex('OwnershipTransferred(address,address)'))
// key-shaped values: none may ever appear in an error, a gap or a log line
const ANKR_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
const INFURA_KEY = '9f8e7d6c5b4a39281706f5e4d3c2b1a0'

// ---- a stubbed fetch behind the real viem http transport --------------------------------------
type Call = { host: string; method: string; params: unknown[]; id: number; t: number }
type Handler = (c: Call, nth: number) => Response
const json = (c: Call, body: Record<string, unknown>, status = 200, headers = {}) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: c.id, ...body }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
const ok = (c: Call, result: unknown) => json(c, { result })
/** A 429 whose body is not JSON-RPC (viem keeps the status and headers). */
const tooMany = (retryAfter?: string) =>
  new Response('Too Many Requests', {
    status: 429,
    headers: retryAfter ? { 'Retry-After': retryAfter } : {},
  })
/** Infura's 429: a JSON-RPC error body (viem 2.54 drops the status and the headers). */
const tooManyRpc = (c: Call, retryAfter?: string) =>
  json(
    c,
    { error: { code: -32005, message: 'project ID request rate exceeded' } },
    429,
    retryAfter ? { 'Retry-After': retryAfter } : {},
  )
function stubFetch(handlers: Record<string, Handler>) {
  const calls: Call[] = []
  const seen = new Map<string, number>()
  vi.stubGlobal('fetch', async (input: unknown, init: { body: string }) => {
    const url = typeof input === 'string' ? input : (input as { url: string }).url
    const body = JSON.parse(init.body)
    const host = new URL(url).host
    const c: Call = { host, method: body.method, params: body.params, id: body.id, t: Date.now() }
    calls.push(c)
    const k = `${host}|${body.method}`
    const nth = seen.get(k) ?? 0
    seen.set(k, nth + 1)
    const h = handlers[host]
    if (!h) throw new Error(`no handler for the host`)
    return h(c, nth)
  })
  return calls
}
/** Advance fake time until the promise settles (every timer and microtask in between runs). */
async function settle<T>(p: Promise<T>, maxMs = 300_000, step = 25): Promise<T> {
  let done = false
  let val: T | undefined
  let err: unknown
  p.then(
    (v) => {
      done = true
      val = v
    },
    (e) => {
      done = true
      err = e
    },
  )
  for (let t = 0; t < maxMs && !done; t += step) await vi.advanceTimersByTimeAsync(step)
  if (!done) throw new Error(`did not settle within ${maxMs} ms of fake time`)
  if (err) throw err
  return val as T
}

// production tuning (vitest defaults the waits to ~0; these tests measure the real schedule)
const PROD = {
  ORACLE_REGISTRY_RPC_TRIES: '5',
  ORACLE_REGISTRY_RPC_BACKOFF_MS: '1000',
  ORACLE_REGISTRY_RPC_BACKOFF_CAP_MS: '20000',
  ORACLE_REGISTRY_RPC_RETRY_BUDGET_MS: '60000',
  ORACLE_REGISTRY_XCHECK_INTERVAL_MS: '1000',
}
let hostN = 0
/** A fresh pair of hosts per test (the per-host limiter is process-wide). */
function clients() {
  hostN++
  const ankr = `rpc${hostN}.ankr.com`
  const infura = `mainnet${hostN}.infura.io`
  process.env.ORACLE_REGISTRY_RPC_URL = `https://${ankr}/eth/${ANKR_KEY},https://${infura}/v3/${INFURA_KEY}`
  return { ankr, infura, ...ethereumClients() }
}
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of [...Object.keys(PROD), 'ORACLE_REGISTRY_RPC_URL']) saved[k] = process.env[k]
  Object.assign(process.env, PROD)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
})
const Q = { address: X, topics0: [TOPIC], fromBlock: 100, toBlock: 5_000 }
const noKey = (s: string) => {
  expect(s).not.toContain(ANKR_KEY)
  expect(s).not.toContain(INFURA_KEY)
  expect(s).not.toMatch(/https?:\/\//)
  expect(s).not.toMatch(/mainnet\d+\.infura|rpc\d+\.ankr/)
}

// =====================================================================================================
describe('lane T (2): the cross-check endpoint retries 429s with backoff, honouring Retry-After', () => {
  it('429 four times, then an answer: the empty range is CONFIRMED (two tries used to give up)', async () => {
    const { ankr, infura, logsPrimary, logsSecondary } = clients()
    const calls = stubFetch({
      [ankr]: (c) => ok(c, []),
      [infura]: (c, n) => (n < 4 ? tooMany() : ok(c, [])),
    })
    const r = await settle(crossCheckedLogs(logsPrimary, logsSecondary, Q))
    expect(r.logs).toEqual([])
    expect(calls.filter((c) => c.host === infura)).toHaveLength(5)
  })
  it("Retry-After is honoured on Infura's JSON-RPC 429 (viem drops the header: retried after 300 ms)", async () => {
    const { ankr, infura, logsPrimary, logsSecondary } = clients()
    const calls = stubFetch({
      [ankr]: (c) => ok(c, []),
      [infura]: (c, n) => (n === 0 ? tooManyRpc(c, '7') : ok(c, [])),
    })
    const r = await settle(crossCheckedLogs(logsPrimary, logsSecondary, Q))
    expect(r.logs).toEqual([])
    const x = calls.filter((c) => c.host === infura)
    expect(x).toHaveLength(2)
    expect(x[1].t - x[0].t).toBeGreaterThanOrEqual(7_000)
  })
  // review of lane T (PLAUSIBLE #1): viem's own retry slept the whole header — no per-call cap
  it("viem's own retry on the primary waits the cap (20 s), not a 3,600 s Retry-After", async () => {
    const { ankr, infura, logsPrimary, logsSecondary } = clients()
    const log = {
      address: X,
      topics: [TOPIC, pad(A('2')), pad(A('3'))],
      data: '0x',
      blockNumber: '0x100',
      logIndex: '0x0',
      transactionHash: '0x' + '1'.repeat(64),
      blockHash: '0x' + '2'.repeat(64),
      transactionIndex: '0x0',
      removed: false,
    }
    const calls = stubFetch({
      [ankr]: (c, n) => (n === 0 ? tooMany('3600') : ok(c, [log])),
      [infura]: (c) => ok(c, []),
    })
    const r = await settle(crossCheckedLogs(logsPrimary, logsSecondary, Q))
    expect(r.logs).toHaveLength(1)
    const x = calls.filter((c) => c.host === ankr)
    expect(x).toHaveLength(2)
    expect(x[1].t - x[0].t).toBeGreaterThanOrEqual(20_000)
    expect(x[1].t - x[0].t).toBeLessThan(21_000)
  })
  it('(control) a non-empty primary answer never reaches the cross-check host', async () => {
    const { ankr, infura, logsPrimary, logsSecondary } = clients()
    const log = {
      address: X,
      topics: [TOPIC, pad(A('2')), pad(A('3'))],
      data: '0x',
      blockNumber: '0x100',
      logIndex: '0x0',
      transactionHash: '0x' + '1'.repeat(64),
      blockHash: '0x' + '2'.repeat(64),
      transactionIndex: '0x0',
      removed: false,
    }
    const calls = stubFetch({ [ankr]: (c) => ok(c, [log]), [infura]: () => tooMany() })
    const r = await settle(crossCheckedLogs(logsPrimary, logsSecondary, Q))
    expect(r.logs).toHaveLength(1)
    expect(calls.filter((c) => c.host === infura)).toHaveLength(0)
  })
})

describe('lane T (3): a chunk that still fails is a gap that names the host LABEL and the status', () => {
  it('a failure whose error describes as nothing is still a gap, never a confirmed chunk (second review)', async () => {
    // describeRpcError gives "" for a message that starts with a newline and carries no status,
    // code or kind; scanLogs decided "unread" by a non-empty error string, so the chunk counted
    // as confirmed (and would be cached once 64 blocks below head)
    const blank = {
      request: async () => {
        throw new Error('\nupstream said nothing')
      },
    }
    const empty = { request: async () => [] }
    const dir = mkdtempSync(join(tmpdir(), 'lane-t-'))
    try {
      const gaps: { error: string; from: number; to: number }[] = []
      await settle(
        (scanLogs as unknown as (o: Record<string, unknown>) => Promise<unknown[]>)({
          client: blank,
          primary: blank,
          secondary: empty,
          chainId: 1,
          addresses: [X],
          topics0: [TOPIC],
          from: 0,
          to: 9_999,
          head: 1_000_000,
          span: 10_000,
          cacheDir: dir,
          gaps,
          scan: 'admin event scan',
        }),
      )
      expect(gaps).toHaveLength(1)
      expect(gaps[0]).toMatchObject({ from: 0, to: 9_999 })
      expect(gaps[0].error).not.toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('5 × 429 on the cross-check host: the gap reads "HTTP 429 from infura.io (cross-check)" (was "HTTP request failed.")', async () => {
    const { ankr, infura, logs, logsPrimary, logsSecondary } = clients()
    const calls = stubFetch({ [ankr]: (c) => ok(c, []), [infura]: () => tooMany() })
    const dir = mkdtempSync(join(tmpdir(), 'lane-t-'))
    try {
      const gaps: { error: string; from: number; to: number }[] = []
      await settle(
        (scanLogs as unknown as (o: Record<string, unknown>) => Promise<unknown[]>)({
          client: logs,
          primary: logsPrimary,
          secondary: logsSecondary,
          chainId: 1,
          addresses: [X],
          topics0: [TOPIC],
          from: 0,
          to: 9_999,
          head: 1_000_000,
          span: 10_000,
          cacheDir: dir,
          gaps,
          scan: 'admin event scan',
        }),
      )
      expect(gaps).toHaveLength(1)
      expect(gaps[0]).toMatchObject({ from: 0, to: 9_999 })
      expect(gaps[0].error).toContain('HTTP 429 from infura.io (cross-check)')
      noKey(gaps[0].error)
      // five tries on the cross-check host, each one paced (≥ 1 s apart)
      const x = calls.filter((c) => c.host === infura)
      expect(x).toHaveLength(5)
      for (let i = 1; i < x.length; i++) expect(x[i].t - x[i - 1].t).toBeGreaterThanOrEqual(1_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it("Infura's JSON-RPC 429 keeps its HTTP status in the gap (viem returns it as RPC -32005)", async () => {
    const { ankr, infura, logsPrimary, logsSecondary } = clients()
    stubFetch({ [ankr]: (c) => ok(c, []), [infura]: (c) => tooManyRpc(c) })
    const err = await settle<Error | null>(
      crossCheckedLogs(logsPrimary, logsSecondary, Q).then(
        () => null,
        (e: Error) => e,
      ),
    )
    expect(String(err?.message)).toContain('HTTP 429 from infura.io (cross-check)')
    noKey(String(err?.message))
  })
  it('a dead primary is named too: "HTTP 503 from ankr.com (primary)"', async () => {
    const { ankr, infura, logsPrimary, logsSecondary } = clients()
    stubFetch({
      [ankr]: () => new Response('upstream down', { status: 503 }),
      [infura]: () => tooMany(),
    })
    const err = await settle<Error | null>(
      crossCheckedLogs(logsPrimary, logsSecondary, { ...Q, toBlock: 150 }).then(
        () => null,
        (e: Error) => e,
      ),
    )
    // the primary failed and the cross-check could not confirm: the thrown error is the primary's
    expect(String(err?.message)).toContain('HTTP 503 from ankr.com (primary)')
    noKey(String(err?.message))
  })
})

describe('lane T (1): the cross-check host is paced — one in flight, ≥ 1 s between starts', () => {
  it('three empty ranges at once: the primary answers all at once, the cross-check host one per second', async () => {
    const { ankr, infura, logsPrimary, logsSecondary } = clients()
    const calls = stubFetch({ [ankr]: (c) => ok(c, []), [infura]: (c) => ok(c, []) })
    const all = Promise.all(
      [0, 1, 2].map((i) =>
        crossCheckedLogs(logsPrimary, logsSecondary, {
          ...Q,
          fromBlock: i * 10_000,
          toBlock: i * 10_000 + 9_999,
        }),
      ),
    )
    await settle(all)
    const p = calls.filter((c) => c.host === ankr)
    const x = calls.filter((c) => c.host === infura)
    expect(p).toHaveLength(3)
    expect(Math.max(...p.map((c) => c.t)) - Math.min(...p.map((c) => c.t))).toBeLessThan(1_000)
    expect(x).toHaveLength(3)
    for (let i = 1; i < x.length; i++) expect(x[i].t - x[i - 1].t).toBeGreaterThanOrEqual(1_000)
  })
})

describe('lane T (5): a deploy-block confirmation that fails is described (host label + status)', () => {
  it('the cross-check host answers 429 to eth_getCode: unconfirmed, retried 5 times, and the reason names it', async () => {
    const { ankr, infura, logsPrimary, logsSecondary } = clients()
    const DEPLOYED = 1_000
    const calls = stubFetch({
      [ankr]: (c) => ok(c, Number(c.params[1]) >= DEPLOYED ? '0x6080' : '0x'),
      [infura]: () => tooMany(),
    })
    // the bisection reads the state client (a fake); the boundary is confirmed on both log hosts
    const state = {
      chain: { id: 1 },
      getCode: async ({ blockNumber }: { blockNumber: bigint }) =>
        blockNumber >= BigInt(DEPLOYED) ? '0x6080' : '0x',
    }
    const probes = (await settle(
      (firstCodeBlocks as unknown as (...a: unknown[]) => Promise<unknown>)(
        state,
        [X],
        () => 0,
        5_000,
        { confirm: [logsPrimary, logsSecondary] },
      ),
    )) as Record<string, { firstCode?: number; unconfirmed?: string }>
    expect(probes[X].firstCode).toBeUndefined()
    expect(probes[X].unconfirmed).toContain('HTTP 429 from infura.io (cross-check)')
    noKey(String(probes[X].unconfirmed))
    expect(calls.filter((c) => c.host === infura && c.method === 'eth_getCode')).toHaveLength(5)
  })
  it('(control) both hosts answer: the deploy block is confirmed', async () => {
    const { ankr, infura, logsPrimary, logsSecondary } = clients()
    const code = (c: Call) => ok(c, Number(c.params[1]) >= 1_000 ? '0x6080' : '0x')
    stubFetch({ [ankr]: code, [infura]: code })
    const state = {
      chain: { id: 1 },
      getCode: async ({ blockNumber }: { blockNumber: bigint }) =>
        blockNumber >= 1_000n ? '0x6080' : '0x',
    }
    const probes = (await settle(
      (firstCodeBlocks as unknown as (...a: unknown[]) => Promise<unknown>)(
        state,
        [X],
        () => 0,
        5_000,
        { confirm: [logsPrimary, logsSecondary] },
      ),
    )) as Record<string, { firstCode?: number }>
    expect(probes[X].firstCode).toBe(1_000)
  })
})

// =====================================================================================================
describe('lane T (4): the holder stream goes on past a failed chunk and records exactly its range', () => {
  const TOKEN = A('70')
  const T = keccak256(toHex('Transfer(address,address,uint256)'))
  const ZERO = '0x0000000000000000000000000000000000000000'
  const tr = (block: number, from: string, to: string, v: bigint, i = 0) => ({
    address: TOKEN,
    topics: [T, pad(from as Hx, { size: 32 }), pad(to as Hx, { size: 32 })],
    data: toHex(v, { size: 32 }),
    blockNumber: toHex(block),
    logIndex: toHex(i),
  })
  const logs = [
    tr(10, ZERO, A('a1'), 600n),
    tr(10, ZERO, A('a2'), 400n, 1),
    tr(250, A('a1'), A('a3'), 100n),
    tr(1_500, A('a2'), ZERO, 50n), // burn
    tr(2_500, A('a3'), A('a4'), 40n),
  ]
  type Range = [number, number]
  type Log = ReturnType<typeof tr>
  const logClient = (o: { fail?: (a: number, b: number) => boolean; logs?: Log[] } = {}) => {
    const asked: Range[] = []
    return {
      asked,
      request: async ({ params }: { params: { fromBlock: string; toBlock: string }[] }) => {
        const a = Number(params[0].fromBlock)
        const b = Number(params[0].toBlock)
        asked.push([a, b])
        if (o.fail?.(a, b)) throw new Error('boom')
        return (o.logs ?? logs).filter(
          (l) => Number(l.blockNumber) >= a && Number(l.blockNumber) <= b,
        )
      },
    }
  }
  const truth = (block: number, ls: Log[] = logs) => {
    const m = new Map<string, bigint>()
    let supply = 0n
    for (const l of ls) if (Number(l.blockNumber) <= block) supply += applyTransfer(m, l)
    return { m, supply }
  }
  const stateOf = (ls: Log[]) => ({
    readContract: async (q: { functionName: string; args?: string[]; blockNumber: bigint }) => {
      const t = truth(Number(q.blockNumber), ls)
      return q.functionName === 'totalSupply'
        ? t.supply
        : (t.m.get(String(q.args![0]).toLowerCase()) ?? 0n)
    },
  })
  const state = stateOf(logs)
  type Snap = { error?: string; unread?: { from: number; to: number }[]; supply?: string }
  const snapshots = holderSnapshots as unknown as (
    o: Record<string, unknown>,
  ) => Promise<Map<number, Snap>>
  // real timers: the fakes answer at once and vitest's waits are ~0
  beforeEach(() => {
    vi.useRealTimers()
    for (const k of Object.keys(PROD)) delete process.env[k]
  })

  it('chunk 200–299 fails on both endpoints: later chunks are still read, and only that range is unread', async () => {
    const bad = (a: number) => a >= 200 && a <= 299
    const primary = logClient({ fail: bad })
    const secondary = logClient({ fail: bad })
    const snaps = await snapshots({
      logClients: { primary, secondary },
      state,
      token: TOKEN,
      from: 0,
      blocks: [150, 2_600],
      span: 100,
      concurrency: 2,
    })
    expect(snaps.get(150)).toMatchObject({ supply: '1000' })
    const after = snaps.get(2_600)!
    expect(after.error).toMatch(/not read from block 200/)
    expect(after.unread?.map((g) => [g.from, g.to])).toEqual([[200, 299]])
    // the stream went on: the chunks after the failed one were asked
    expect(primary.asked.some(([a]) => a === 2_600)).toBe(true)
    expect(primary.asked.some(([a]) => a === 300)).toBe(true)
  })
  it('two failed chunks: both ranges are listed, a snapshot between them names only the first', async () => {
    const bad = (a: number) => (a >= 200 && a <= 299) || (a >= 1_700 && a <= 1_799)
    const snaps = await snapshots({
      logClients: { primary: logClient({ fail: bad }), secondary: logClient({ fail: bad }) },
      state,
      token: TOKEN,
      from: 0,
      blocks: [1_000, 2_600],
      span: 100,
      concurrency: 3,
    })
    expect(snaps.get(1_000)!.unread?.map((g) => [g.from, g.to])).toEqual([[200, 299]])
    expect(snaps.get(2_600)!.unread?.map((g) => [g.from, g.to])).toEqual([
      [200, 299],
      [1_700, 1_799],
    ])
  })
  it('a chunk whose read fails through every getLogs try is retried as a whole: no gap at all', async () => {
    // the primary fails that range twice (both tries of one getLogs), then answers
    let fails = 0
    const flaky = {
      request: async (q: { params: { fromBlock: string; toBlock: string }[] }) => {
        const a = Number(q.params[0].fromBlock)
        if (a === 200 && fails < 2) {
          fails++
          throw new Error('boom')
        }
        return logClient().request(q)
      },
    }
    // the secondary fails that range for good: only a retry of the whole chunk can read it
    const snaps = await snapshots({
      logClients: { primary: flaky, secondary: logClient({ fail: (a) => a === 200 }) },
      state,
      token: TOKEN,
      from: 0,
      blocks: [2_600],
      span: 100,
    })
    expect(snaps.get(2_600)).toMatchObject({ supply: String(truth(2_600).supply) })
    expect(snaps.get(2_600)!.error).toBeUndefined()
  })
  it('the confirmed prefix is checkpointed in the cache; the next run resumes after it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lane-t-h-'))
    const cacheFile = join(dir, 'holders.json')
    try {
      const first = await snapshots({
        logClients: { primary: logClient(), secondary: logClient() },
        state,
        token: TOKEN,
        from: 0,
        blocks: [2_000],
        span: 100,
        cacheFile,
      })
      expect(first.get(2_000)!.error).toBeUndefined()
      // a later block: streamed from the checkpoint (the last chunk end ≥ 64 below 2,000)
      const primary = logClient()
      const second = await snapshots({
        logClients: { primary, secondary: logClient() },
        state,
        token: TOKEN,
        from: 0,
        blocks: [3_000],
        span: 100,
        cacheFile,
      })
      expect(second.get(3_000)).toMatchObject({ supply: String(truth(3_000).supply) })
      expect(second.get(3_000)!.error).toBeUndefined()
      expect(Math.min(...primary.asked.map(([a]) => a))).toBe(1_900)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('(control) a checkpoint that does not verify on chain is dropped: the stream starts over', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lane-t-h-'))
    const cacheFile = join(dir, 'holders.json')
    try {
      await snapshots({
        logClients: { primary: logClient(), secondary: logClient() },
        state,
        token: TOKEN,
        from: 0,
        blocks: [2_000],
        span: 100,
        cacheFile,
      })
      const c = JSON.parse(readFileSync(cacheFile, 'utf8'))
      const k = Object.keys(c).find((x) => x.endsWith('@checkpoint'))
      if (k) {
        c[k].balances = c[k].balances.map(([a, v]: [string, string]) => [a, String(BigInt(v) + 1n)])
        writeFileSync(cacheFile, JSON.stringify(c))
      }
      const primary = logClient()
      const snaps = await snapshots({
        logClients: { primary, secondary: logClient() },
        state,
        token: TOKEN,
        from: 0,
        blocks: [3_000],
        span: 100,
        cacheFile,
      })
      expect(snaps.get(3_000)).toMatchObject({ supply: String(truth(3_000).supply) })
      expect(Math.min(...primary.asked.map(([a]) => a))).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Review of lane T (CONFIRMED-BUG): the checkpoint was saved AFTER the loop with the balances
  // of the whole stream but labelled with the last confirmed-prefix chunk end — a transfer in the
  // tail chunk (above the 64-block margin) or after an unread chunk sat inside a checkpoint dated
  // before it. The resume fixture above has no transfer in blocks 1,900–2,000, so it never saw it.
  type Ck = { block: number; supply: string; balances: [string, string][] }
  const checkpointOf = (cacheFile: string): Ck | undefined => {
    const c = JSON.parse(readFileSync(cacheFile, 'utf8'))
    const k = Object.keys(c).find((x) => x.endsWith('@checkpoint'))
    return k ? c[k] : undefined
  }
  const nonZero = (m: Map<string, bigint>) =>
    Object.fromEntries([...m].filter(([, v]) => v !== 0n).map(([a, v]) => [a, String(v)]))
  it('the checkpoint holds the balances AT its block: a tail-chunk transfer is not inside it, and the next run resumes', async () => {
    const ls = [...logs, tr(1_950, A('a1'), A('a2'), 7n)]
    const st = stateOf(ls)
    const dir = mkdtempSync(join(tmpdir(), 'lane-t-h-'))
    const cacheFile = join(dir, 'holders.json')
    try {
      await snapshots({
        logClients: { primary: logClient({ logs: ls }), secondary: logClient({ logs: ls }) },
        state: st,
        token: TOKEN,
        from: 0,
        blocks: [2_000],
        span: 100,
        cacheFile,
      })
      const ck = checkpointOf(cacheFile)!
      // the last chunk end ≥ 64 below 2,000 is 1,899: the 1,950 transfer is after it
      expect(ck.block).toBe(1_899)
      expect(ck.supply).toBe(String(truth(1_899, ls).supply))
      expect(Object.fromEntries(ck.balances)).toEqual(nonZero(truth(1_899, ls).m))
      // was: "checkpoint at 1899 dropped" (a1 / a2 are top holders) and a stream from block 0
      const primary = logClient({ logs: ls })
      const lines: string[] = []
      const second = await snapshots({
        logClients: { primary, secondary: logClient({ logs: ls }) },
        state: st,
        token: TOKEN,
        from: 0,
        blocks: [3_000],
        span: 100,
        cacheFile,
        log: (l: string) => lines.push(l),
      })
      expect(lines.some((l) => /dropped/.test(l))).toBe(false)
      expect(Math.min(...primary.asked.map(([a]) => a))).toBe(1_900)
      expect(second.get(3_000)).toMatchObject({ supply: String(truth(3_000, ls).supply) })
      expect(second.get(3_000)!.error).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('a tail transfer between holders ranked 59 and 60 is not applied twice on resume (was a false "not verified" read gap)', async () => {
    // 60 holders, h_i minted 100,000 − 1,000·i; at 1,950 h59 pays h60 9,500 (h60 stays rank 51:
    // the top-50 checkpoint verification cannot see a double debit there — only the snapshot can,
    // once h60 is pushed into the top 50 by a second application)
    const h = (i: number) => ('0x' + (0x1000 + i).toString(16).padStart(40, '0')) as Hx
    const ls = [
      ...Array.from({ length: 60 }, (_, k) =>
        tr(10, ZERO, h(k + 1), BigInt(100_000 - 1_000 * (k + 1)), k),
      ),
      tr(1_950, h(59), h(60), 9_500n),
    ]
    const st = stateOf(ls)
    const dir = mkdtempSync(join(tmpdir(), 'lane-t-h-'))
    const cacheFile = join(dir, 'holders.json')
    try {
      await snapshots({
        logClients: { primary: logClient({ logs: ls }), secondary: logClient({ logs: ls }) },
        state: st,
        token: TOKEN,
        from: 0,
        blocks: [2_000],
        span: 100,
        cacheFile,
      })
      const ck = checkpointOf(cacheFile)!
      expect(Object.fromEntries(ck.balances)[h(60)]).toBe('40000')
      const second = await snapshots({
        logClients: { primary: logClient({ logs: ls }), secondary: logClient({ logs: ls }) },
        state: st,
        token: TOKEN,
        from: 0,
        blocks: [3_000],
        span: 100,
        cacheFile,
      })
      expect(second.get(3_000)!.error).toBeUndefined()
      expect(second.get(3_000)).toMatchObject({ supply: String(truth(3_000, ls).supply) })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('with an unread chunk, the checkpoint is dated before it and holds no transfer after it', async () => {
    // 1,000–1,099 fails on both endpoints; 1,500 (a burn) and 2,500 are read after it
    const bad = (a: number) => a >= 1_000 && a <= 1_099
    const dir = mkdtempSync(join(tmpdir(), 'lane-t-h-'))
    const cacheFile = join(dir, 'holders.json')
    try {
      const snaps = await snapshots({
        logClients: { primary: logClient({ fail: bad }), secondary: logClient({ fail: bad }) },
        state,
        token: TOKEN,
        from: 0,
        blocks: [2_600],
        span: 100,
        cacheFile,
      })
      expect(snaps.get(2_600)!.unread?.map((g) => [g.from, g.to])).toEqual([[1_000, 1_099]])
      const ck = checkpointOf(cacheFile)!
      expect(ck.block).toBe(999)
      expect(ck.supply).toBe(String(truth(999).supply))
      expect(Object.fromEntries(ck.balances)).toEqual(nonZero(truth(999).m))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// =====================================================================================================
describe('lane T (6): the token-vote log line counts only classifications that had holder data', () => {
  beforeEach(() => vi.useRealTimers())
  const VOTING = A('76')
  const vote = () => ({
    kind: 'aragon_voting',
    address: VOTING,
    delaySec: 432000,
    voting: {
      voteTimeSec: 432000,
      objectionPhaseSec: null,
      token: A('70'),
      supportRequiredPct: '500000000000000000',
      minAcceptQuorumPct: '50000000000000000',
    },
  })
  it('every holder snapshot errored: "0 of 2 … given holder data; 2 holder snapshot(s) errored" (was "2 … given")', async () => {
    const lines: string[] = []
    await (enrichTokenVotes as unknown as (...a: unknown[]) => Promise<number>)(
      {},
      { [`${VOTING}@100`]: vote(), [`${VOTING}@200`]: vote() },
      {
        head: 1_000,
        decide: () => ({ kind: 'unread' }),
        defenseFor: async () => ({ votes: 0, meanNay: '0' }),
        snapshotsFor: async (_t: string, blocks: number[]) =>
          new Map(
            blocks.map((b) => [
              b,
              {
                error: `Transfer logs not read from block 200 (unread: 200–299; HTTP 429 from infura.io (cross-check))`,
              },
            ]),
          ),
        log: (s: string) => lines.push(s),
      },
    )
    const line = lines.find((l) => /token vote/.test(l)) ?? ''
    expect(line).toMatch(
      /: 0 of 2 classification\(s\) given holder data; 2 holder snapshot\(s\) errored/,
    )
    expect(line).toContain('HTTP 429 from infura.io (cross-check)')
  })
})
