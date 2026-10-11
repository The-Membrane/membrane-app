import { describe, expect, it } from 'vitest'
import { custom, toHex } from 'viem'

import {
  PROBE_ANCHOR_BLOCK,
  PROBE_ANCHOR_TX,
  RingCoverageError,
  RingEmptyUnconfirmedError,
  RpcRing,
  backendOf,
  probeRing,
  queryOf,
  redactUrls,
  type RingTable,
  type RpcCall,
  type TransportFor,
} from '@/lib/position-sim/rpcRing'

// A fake JSON-RPC network behind viem's `custom` transport, so the ring runs its real
// client path. Each host is scripted per call: 'honest' serves the chain below, 'empty'
// answers [] (Pocket's measured failure), 'short' drops half the logs, 'error' fails.
type Mode = 'honest' | 'empty' | 'short' | 'error' | 'limited'
type Script = Mode | ((callNo: number, from: bigint, to: bigint) => Mode)

const AGG = '0x7d4e742018fb52e48b08be73d041c18b21de6fb5'
const TOPIC0 = '0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f'
const HEAD = 30_000_000n
const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}` as const

function rawLog(block: bigint, idx: number, tx?: string) {
  return {
    address: AGG,
    topics: [TOPIC0, word(2_000n * 10n ** 8n), word(block)],
    data: word(1_700_000_000n),
    blockNumber: toHex(block),
    blockHash: word(block),
    transactionHash: tx ?? word(block * 1_000n + BigInt(idx)),
    transactionIndex: '0x0',
    logIndex: toHex(idx),
    removed: false,
  }
}

/** One AnswerUpdated every 300 blocks over [1,000,000, 1,080,000) — an hourly feed —
 *  plus the probe anchor. Nothing in [2,000,000, 2,100,000): a genuinely quiet range. */
const CHAIN = [
  ...Array.from({ length: 267 }, (_, i) => rawLog(1_000_000n + BigInt(i) * 300n, i % 7)),
  rawLog(PROBE_ANCHOR_BLOCK, 415, PROBE_ANCHOR_TX),
]
const truth = (from: bigint, to: bigint) =>
  CHAIN.filter((l) => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to)

function fakeNet(scripts: Record<string, Script>) {
  const calls: { host: string; from: bigint; to: bigint; mode: Mode }[] = []
  const transportFor: TransportFor = (url, opts) =>
    custom(
      {
        async request({ method, params }: { method: string; params: any }) {
          const host = new URL(url).host
          if (method === 'eth_blockNumber') return toHex(HEAD)
          if (method === 'eth_chainId') return '0x1'
          if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`)
          const from = BigInt(params[0].fromBlock)
          const to = BigInt(params[0].toBlock)
          const s = scripts[host] ?? 'honest'
          const mode = typeof s === 'function' ? s(calls.filter((c) => c.host === host).length, from, to) : s
          calls.push({ host, from, to, mode })
          if (mode === 'error') throw new Error(`429 too many requests at ${url}`)
          if (mode === 'limited') throw Object.assign(new Error('limit exceeded'), { code: -32005 })
          if (mode === 'empty') return []
          const hits = truth(from, to)
          return mode === 'short' ? hits.slice(0, Math.floor(hits.length / 2)) : hits
        },
      },
      { retryCount: opts.retryCount },
    )
  const of = (host: string) => calls.filter((c) => c.host === host)
  return { transportFor, calls, of }
}

const table = (...rows: [url: string, cap: number, ms: number][]): RingTable => ({
  probedAt: new Date().toISOString(),
  entries: rows.map(([url, cap, ms]) => ({ url, cap, ms, alive: true })),
})
const POCKET = 'https://eth.api.pocket.network'
const TENDERLY = 'https://gateway.tenderly.co/public/mainnet'
const TENDERLY2 = 'https://mainnet.gateway.tenderly.co'
const MEVB = 'https://rpc.mevblocker.io'
const BLOCKPI = 'https://ethereum.public.blockpi.network/v1/rpc/public'
const q = (fromBlock: bigint, toBlock: bigint) => ({ address: AGG as `0x${string}`, fromBlock, toBlock })
const blocks = (logs: unknown[]) => logs.map((l) => (l as { blockNumber: bigint }).blockNumber)

describe('rpc ring: an empty answer is not a fact', () => {
  it('recovers a false-empty chunk from an independent backend and quarantines the liar', async () => {
    const net = fakeNet({ 'eth.api.pocket.network': 'empty' })
    // Pocket is listed fastest, so the ring asks it first.
    const ring = new RpcRing(table([POCKET, 10_000, 1], [TENDERLY, 10_000, 50]), { transportFor: net.transportFor })
    const { logs, coverage } = await ring.getLogsWideChecked(q(1_000_000n, 1_029_999n))

    expect(blocks(logs)).toEqual(truth(1_000_000n, 1_029_999n).map((l) => BigInt(l.blockNumber)))
    expect(coverage.confidence).toBe('verified')
    expect(coverage.recovered).toEqual([
      { fromBlock: 1_000_000n, toBlock: 1_009_999n, host: 'eth.api.pocket.network', logs: 34 },
    ])
    // One strike and Pocket is out for the run: every later piece goes to Tenderly.
    expect(net.of('eth.api.pocket.network')).toHaveLength(1)
    const pocket = ring.stats().find((s) => s.host === 'eth.api.pocket.network')
    expect(pocket).toMatchObject({ empty: 1, falseEmpty: 1, quarantined: true })
    expect(ring.checks()).toMatchObject({ rechecked: 1, recovered: 1, unverified: 0 })
  })

  it('accepts an empty range only when two independent backends agree', async () => {
    const net = fakeNet({})
    const ring = new RpcRing(table([POCKET, 10_000, 1], [TENDERLY, 10_000, 50]), { transportFor: net.transportFor })
    const { logs, coverage } = await ring.getLogsWideChecked(q(2_000_000n, 2_009_999n))

    expect(logs).toEqual([])
    expect(coverage).toMatchObject({ pieces: 1, confirmedEmpty: 1, confidence: 'verified' })
    expect(new Set(net.calls.map((c) => c.host))).toEqual(new Set(['eth.api.pocket.network', 'gateway.tenderly.co']))
    expect(ring.stats().every((s) => s.falseEmpty === 0 && !s.quarantined)).toBe(true)
  })

  it('does not let two hosts of one backend confirm each other', async () => {
    expect(backendOf(TENDERLY)).toBe(backendOf(TENDERLY2))
    const net = fakeNet({})
    const ring = new RpcRing(table([TENDERLY, 10_000, 1], [TENDERLY2, 10_000, 2]), {
      transportFor: net.transportFor,
      cooldownMs: 1,
    })
    await expect(ring.getLogs(q(2_000_000n, 2_009_999n))).rejects.toBeInstanceOf(RingEmptyUnconfirmedError)
    // Only the first host was asked: the second shares its backend.
    expect(new Set(net.calls.map((c) => c.host))).toEqual(new Set(['gateway.tenderly.co']))

    const { coverage } = await ring.getLogsWideChecked(q(2_000_000n, 2_009_999n))
    expect(coverage.confidence).toBe('unverified')
    expect(coverage.unverified).toEqual([{ fromBlock: 2_000_000n, toBlock: 2_009_999n, host: 'gateway.tenderly.co', logs: 0 }])
    await expect(ring.getLogsWide(q(2_000_000n, 2_009_999n))).rejects.toBeInstanceOf(RingCoverageError)
  })

  it('treats an error as an error: the endpoint cools, it is not quarantined', async () => {
    const net = fakeNet({ 'eth.api.pocket.network': (n) => (n === 0 ? 'error' : 'honest') })
    const ring = new RpcRing(table([POCKET, 10_000, 1], [TENDERLY, 10_000, 50]), {
      transportFor: net.transportFor,
      cooldownMs: 1,
    })
    const logs = await ring.getLogs(q(1_000_000n, 1_009_999n))

    expect(logs).toHaveLength(34)
    const pocket = ring.stats().find((s) => s.host === 'eth.api.pocket.network')
    expect(pocket).toMatchObject({ failed: 1, falseEmpty: 0, quarantined: false })
    await new Promise((r) => setTimeout(r, 5))
    await ring.getLogs(q(1_010_000n, 1_019_999n))
    expect(net.of('eth.api.pocket.network').map((c) => c.mode)).toEqual(['error', 'honest'])
  })

  it('halves the span until a second endpoint can check an empty', async () => {
    const net = fakeNet({})
    // Only Pocket serves 10k; BlockPI serves 5k. A 10k empty cannot be checked at 10k.
    const ring = new RpcRing(table([POCKET, 10_000, 1], [BLOCKPI, 5_000, 50]), {
      transportFor: net.transportFor,
      cooldownMs: 1,
    })
    const { logs, coverage } = await ring.getLogsWideChecked(q(2_000_000n, 2_009_999n))

    expect(logs).toEqual([])
    expect(coverage).toMatchObject({ pieces: 2, confirmedEmpty: 2, confidence: 'verified' })
    expect(net.calls.map((c) => `${c.host}:${c.to - c.from + 1n}`)).toEqual([
      'eth.api.pocket.network:10000',
      'eth.api.pocket.network:5000',
      'ethereum.public.blockpi.network:5000',
      'eth.api.pocket.network:5000',
      'ethereum.public.blockpi.network:5000',
    ])
  })

  it("verify 'all' catches a short answer and keeps the union", async () => {
    const net = fakeNet({ 'eth.api.pocket.network': 'short' })
    const ring = new RpcRing(table([POCKET, 10_000, 1], [TENDERLY, 10_000, 50]), {
      transportFor: net.transportFor,
      verify: 'all',
    })
    const { logs, coverage } = await ring.getLogsWideChecked(q(1_000_000n, 1_009_999n))

    expect(blocks(logs)).toEqual(truth(1_000_000n, 1_009_999n).map((l) => BigInt(l.blockNumber)))
    expect(coverage.recovered).toHaveLength(1)
    expect(ring.stats().find((s) => s.host === 'eth.api.pocket.network')?.quarantined).toBe(true)
  })

  it("verify 'none' keeps the old behaviour but still flags every empty", async () => {
    const net = fakeNet({ 'eth.api.pocket.network': 'empty' })
    const ring = new RpcRing(table([POCKET, 10_000, 1], [TENDERLY, 10_000, 50]), {
      transportFor: net.transportFor,
      verify: 'none',
    })
    expect(await ring.getLogsWide(q(1_000_000n, 1_009_999n))).toEqual([])
    const { coverage } = await ring.getLogsWideChecked(q(1_000_000n, 1_009_999n))
    expect(coverage.confidence).toBe('unverified')
    expect(coverage.unverified[0]).toMatchObject({ host: 'eth.api.pocket.network', logs: 0 })
  })

  it('concurrent pieces: every false-empty piece is recovered and the result is complete', async () => {
    // Pocket lies on every other call and is never quarantined, so it keeps taking work.
    const net = fakeNet({ 'eth.api.pocket.network': (n) => (n % 2 === 0 ? 'empty' : 'honest') })
    const ring = new RpcRing(table([POCKET, 10_000, 1], [TENDERLY, 10_000, 5], [MEVB, 10_000, 9]), {
      transportFor: net.transportFor,
      quarantineMs: 0,
    })
    const { logs, coverage } = await ring.getLogsWideChecked(q(1_000_000n, 1_079_999n), 4)

    expect(blocks(logs)).toEqual(truth(1_000_000n, 1_079_999n).map((l) => BigInt(l.blockNumber)))
    expect(coverage.confidence).toBe('verified')
    const lies = net.of('eth.api.pocket.network').filter((c) => c.mode === 'empty').length
    expect(lies).toBeGreaterThan(0)
    expect(coverage.recovered).toHaveLength(lies)
  })
})

describe('rpc ring probe', () => {
  it('counts a cap only when the answer holds the anchor log', async () => {
    const net = fakeNet({
      'eth.api.pocket.network': 'empty',
      'ethereum.public.blockpi.network': (_n, from, to) => (to - from + 1n > 5_000n ? 'error' : 'honest'),
      'rpc.mevblocker.io': (n) => (n === 0 ? 'empty' : 'honest'),
    })
    const t = await probeRing([], [POCKET, BLOCKPI, MEVB, TENDERLY], { transportFor: net.transportFor, pauseMs: 0 })
    const by = Object.fromEntries(t.entries.map((e) => [new URL(e.url).host, e]))

    // The old probe window held no logs, so an all-empty endpoint scored 10,000.
    expect(by['eth.api.pocket.network']).toMatchObject({ cap: 0, alive: true, emptyAnswers: 22 })
    expect(by['ethereum.public.blockpi.network'].cap).toBe(5_000)
    // One empty answer, then the anchor: the cap stands, and the empty is on record.
    expect(by['rpc.mevblocker.io']).toMatchObject({ cap: 10_000, emptyAnswers: 1 })
    expect(by['gateway.tenderly.co'].cap).toBe(10_000)
    expect(by['gateway.tenderly.co'].emptyAnswers).toBeUndefined()
  })
})

describe('rpc ring ledger: which endpoint answered which range', () => {
  const ledgerRing = (scripts: Record<string, Script>, rows: [string, number, number][], opts: object = {}) => {
    const net = fakeNet(scripts)
    const calls: RpcCall[] = []
    const ring = new RpcRing(table(...rows), { transportFor: net.transportFor, onCall: (c) => calls.push(c), ...opts })
    return { net, calls, ring }
  }

  it('records the false empty, who contradicted it, and the piece verdict', async () => {
    const { calls, ring } = ledgerRing({ 'eth.api.pocket.network': 'empty' }, [[POCKET, 10_000, 1], [TENDERLY, 10_000, 50]])
    await ring.getLogs(q(1_000_000n, 1_009_999n))

    const piece = calls[0].piece
    expect(calls.map(({ at, ms, ...c }) => c)).toEqual([
      { piece, host: 'eth.api.pocket.network', query: `logs@${AGG}`, fromBlock: 1_000_000n, toBlock: 1_009_999n,
        role: 'first', outcome: 'empty', logs: 0, errorCode: null, verdict: 'recovered', contradicted: true },
      { piece, host: 'gateway.tenderly.co', query: `logs@${AGG}`, fromBlock: 1_000_000n, toBlock: 1_009_999n,
        role: 'recheck', outcome: 'logs', logs: 34, errorCode: null, verdict: 'recovered', contradicted: false },
    ])
    expect(calls.every((c) => !Number.isNaN(Date.parse(c.at)) && c.ms >= 0)).toBe(true)
  })

  it('records errors with their code only, and never a key from the URL', async () => {
    const KEYED = 'https://rpc.ankr.com/eth/SECRETKEY123'
    // Tenderly is asked first and rate-limits; the keyed Ankr is asked last, and its
    // error text carries its full URL — the case that leaked keys into scan logs.
    const { calls, ring } = ledgerRing(
      { 'gateway.tenderly.co': 'limited', 'rpc.ankr.com': 'error' },
      [[TENDERLY, 10_000, 1], [KEYED, 10_000, 50]],
      { cooldownMs: 1 },
    )
    const err = await ring.getLogs(q(1_000_000n, 1_009_999n)).catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect(calls.map((c) => [c.host, c.outcome, c.errorCode, c.verdict])).toEqual([
      ['gateway.tenderly.co', 'error', -32005, 'failed'],
      // viem wraps an error with no code as UnknownRpcError, code -1.
      ['rpc.ankr.com', 'error', -1, 'failed'],
    ])
    expect(String(err)).toContain('rpc.ankr.com')
    const leaks = [JSON.stringify(calls, (_k, v) => (typeof v === 'bigint' ? String(v) : v)), JSON.stringify(ring.stats()), String(err)]
    for (const text of leaks) expect(text).not.toContain('SECRETKEY123')
    expect(redactUrls(`fetch failed URL: ${KEYED} status 429`)).toBe('fetch failed URL: rpc.ankr.com status 429')
  })

  it('spot-checks a sampled non-empty answer and catches a short one', async () => {
    const { calls, ring } = ledgerRing({ 'eth.api.pocket.network': 'short' }, [[POCKET, 10_000, 1], [TENDERLY, 10_000, 50]], {
      spotCheckRate: 0.5,
      random: () => 0.1,
    })
    const logs = await ring.getLogs(q(1_000_000n, 1_009_999n))

    expect(logs).toHaveLength(34)
    expect(calls.map((c) => [c.host, c.role, c.outcome, c.contradicted, c.verdict])).toEqual([
      ['eth.api.pocket.network', 'first', 'logs', true, 'recovered'],
      ['gateway.tenderly.co', 'spot', 'logs', false, 'recovered'],
    ])
    expect(ring.checks()).toMatchObject({ rechecked: 1, spotChecked: 1, recovered: 1 })
  })

  it('leaves an unsampled non-empty answer single, and numbers each piece', async () => {
    const { calls, ring } = ledgerRing({}, [[POCKET, 10_000, 1], [TENDERLY, 10_000, 50]], { spotCheckRate: 0.5, random: () => 0.9 })
    await ring.getLogsWide(q(1_000_000n, 1_029_999n))

    const p0 = calls[0].piece
    expect(calls.map((c) => [c.piece - p0, c.role, c.verdict])).toEqual([
      [0, 'first', 'single'],
      [1, 'first', 'single'],
      [2, 'first', 'single'],
    ])
    expect(ring.checks().spotChecked).toBe(0)
    // A second ring in the same process keeps numbering: (run, piece) stays unique.
    const other = ledgerRing({}, [[TENDERLY, 10_000, 1]], { verify: 'none' })
    await other.ring.getLogs(q(1_000_000n, 1_009_999n))
    expect(other.calls[0].piece).toBeGreaterThan(calls[2].piece)
  })

  it('a spot-check that finds no second endpoint leaves the answer single, and the wide scan does not throw', async () => {
    // Only one backend: the sampled re-ask has nobody to ask.
    const { calls, ring } = ledgerRing({}, [[TENDERLY, 10_000, 1], [TENDERLY2, 10_000, 2]], { spotCheckRate: 1, random: () => 0 })
    const { logs, coverage } = await ring.getLogsWideChecked(q(1_000_000n, 1_009_999n))

    expect(logs).toHaveLength(34)
    expect(coverage).toMatchObject({ confidence: 'verified', unverified: [] })
    expect(calls.map((c) => [c.role, c.verdict])).toEqual([['first', 'single']])
    expect(ring.checks()).toMatchObject({ rechecked: 0, spotChecked: 0, unverified: 0 })
    await expect(ring.getLogsWide(q(1_000_000n, 1_009_999n))).resolves.toHaveLength(34)
  })

  it('labels a keyed RECORDER_RPC_URL endpoint env:<host>, apart from the free tier on the same host', async () => {
    const KEYED_TENDERLY = 'https://mainnet.gateway.tenderly.co/SECRETKEY789'
    const before = process.env.RECORDER_RPC_URL
    process.env.RECORDER_RPC_URL = KEYED_TENDERLY
    try {
      const { calls, ring } = ledgerRing({ 'mainnet.gateway.tenderly.co': 'empty' }, [[KEYED_TENDERLY, 10_000, 1], [MEVB, 10_000, 50]])
      await ring.getLogs(q(1_000_000n, 1_009_999n))
      expect(calls.map((c) => c.host)).toEqual(['env:mainnet.gateway.tenderly.co', 'rpc.mevblocker.io'])
      expect(JSON.stringify(calls, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain('SECRETKEY789')
    } finally {
      if (before === undefined) delete process.env.RECORDER_RPC_URL
      else process.env.RECORDER_RPC_URL = before
    }
  })

  it('names a query by event and sorted addresses', () => {
    expect(queryOf({ address: ['0xB', '0xa'], event: { name: 'AnswerUpdated' } })).toBe('AnswerUpdated@0xa,0xb')
    expect(queryOf({ address: '0xA', event: { name: 'LiquidationCall' }, args: { user: '0x1' } })).toBe('LiquidationCall@0xa#filtered')
  })
})
