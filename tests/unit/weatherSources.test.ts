import type { PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { HOUR_MS } from '@/lib/regime/m0'
import {
  CHAINLINK_ETH_USD,
  hourGrid,
  readBaseFee,
  readChainlinkHourly,
  readCoinbaseHourly,
  readDvolEth,
} from '@/lib/weather/sources'

// The weather readers against mocked fetch and viem clients: shapes, the hour-end
// convention, dropping the candle still forming, the Chainlink walk and its stops, and
// the never-throw contract (errors come back redacted).

const H = Date.UTC(2026, 9, 14, 12)
const NOW = H + 20 * 60_000

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  )

describe('hourGrid', () => {
  it('ends at the latest completed hour, oldest first', () => {
    const g = hourGrid(NOW, 3)
    expect(g).toEqual([H - 2 * HOUR_MS, H - HOUR_MS, H])
    expect(hourGrid(H, 1)).toEqual([H])
  })
})

describe('readBaseFee', () => {
  it('reads the latest block base fee in gwei', async () => {
    const client = {
      getBlock: vi.fn(async () => ({
        baseFeePerGas: 412_345_678n,
        number: 23_000_000n,
        timestamp: BigInt(NOW / 1000 - 9),
      })),
    } as unknown as PublicClient
    const r = await readBaseFee(client)
    expect(r).toEqual({
      ok: true,
      data: { gwei: 0.412345678, block: 23_000_000, asOfMs: NOW - 9000 },
    })
  })

  it('fails, never throws, with the URL redacted', async () => {
    const client = {
      getBlock: vi.fn(async () => {
        throw new Error(
          'HTTP request failed. URL: https://rpc.example/key123 status 500\nDetails: x',
        )
      }),
    } as unknown as PublicClient
    const r = await readBaseFee(client)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).not.toMatch(/key123|https?:/)
      expect(r.error).toContain('[rpc]')
    }
  })

  it('a block with no base fee is a failure', async () => {
    const client = {
      getBlock: vi.fn(async () => ({ baseFeePerGas: null, number: 1n, timestamp: 1n })),
    } as unknown as PublicClient
    expect((await readBaseFee(client)).ok).toBe(false)
  })

  it('times out', async () => {
    const client = { getBlock: vi.fn(() => new Promise(() => {})) } as unknown as PublicClient
    const r = await readBaseFee(client, 20)
    expect(r).toEqual({ ok: false, error: 'timed out after 20 ms' })
  })
})

describe('readDvolEth', () => {
  it('takes the newest CLOSED candle and divides by √365', async () => {
    const fetchImpl = vi.fn((_url: string) =>
      json({
        result: {
          data: [
            [H - 2 * HOUR_MS, 50, 51, 49, 50.5],
            [H - HOUR_MS, 50.5, 52, 50, 51.47],
            // Still forming (opens at H, closes after now): skipped.
            [H, 51.47, 53, 51, 60],
          ],
        },
      }),
    )
    const r = await readDvolEth(fetchImpl, NOW)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.dvol).toBe(51.47)
      expect(r.data.dailyMovePct).toBeCloseTo(51.47 / Math.sqrt(365), 12)
      expect(r.data.candleOpenMs).toBe(H - HOUR_MS)
      expect(r.data.asOfMs).toBe(H)
    }
    const url = new URL(fetchImpl.mock.calls[0][0])
    expect(url.host).toBe('www.deribit.com')
    expect(url.searchParams.get('currency')).toBe('ETH')
    expect(url.searchParams.get('resolution')).toBe('3600')
    expect(url.searchParams.get('end_timestamp')).toBe(String(NOW))
  })

  it('fails on HTTP errors, empty data and timeouts', async () => {
    expect((await readDvolEth(() => json({}, 502), NOW)).ok).toBe(false)
    expect((await readDvolEth(() => json({ result: { data: [] } }), NOW)).ok).toBe(false)
    expect((await readDvolEth(() => json({ result: { data: [[H, 1, 1, 1, 50]] } }), NOW)).ok).toBe(
      false,
    )
    const hang = await readDvolEth(() => new Promise(() => {}), NOW, 20)
    expect(hang).toEqual({ ok: false, error: 'timed out after 20 ms' })
  })
})

describe('readCoinbaseHourly', () => {
  it('maps open-time candles to hour-end closes on the grid, newest-first input', async () => {
    const s = (t: number) => t / 1000
    const fetchImpl = vi.fn((_url: string) =>
      json([
        // [time (open, s), low, high, open, close, volume]; the first is still forming.
        [s(H), 1, 2, 3, 2510, 9],
        [s(H - HOUR_MS), 1, 2, 3, 2505.46, 9],
        // H − 1h is missing.
        [s(H - 3 * HOUR_MS), 1, 2, 3, 2495.83, 9],
      ]),
    )
    const r = await readCoinbaseHourly(fetchImpl, NOW, 4)
    expect(r).toEqual({
      ok: true,
      data: {
        points: [
          { t: H - 3 * HOUR_MS, v: null },
          { t: H - 2 * HOUR_MS, v: 2495.83 },
          { t: H - HOUR_MS, v: null },
          { t: H, v: 2505.46 },
        ],
        asOfMs: H,
      },
    })
    const url = new URL(fetchImpl.mock.calls[0][0])
    expect(url.searchParams.get('granularity')).toBe('3600')
    expect(url.searchParams.get('start')).toBe(new Date(H - 4 * HOUR_MS).toISOString())
  })

  it('no closed candle → all null and no as-of; non-list → failure', async () => {
    const r = await readCoinbaseHourly(() => json([]), NOW, 2)
    expect(r).toEqual({
      ok: true,
      data: {
        points: [
          { t: H - HOUR_MS, v: null },
          { t: H, v: null },
        ],
        asOfMs: null,
      },
    })
    expect((await readCoinbaseHourly(() => json({ message: 'bad' }), NOW)).ok).toBe(false)
    expect((await readCoinbaseHourly(() => Promise.reject(new Error('ECONNRESET')), NOW)).ok).toBe(
      false,
    )
  })
})

// ------------------------------------------------------------------ Chainlink

const PHASE = 6n
const proxyId = (n: bigint) => (PHASE << 64n) | n

/** A fake aggregator: rounds 1..n, round i updated at updatedAtS(i), answer 2500 + i. */
function chainlinkClient(
  n: number,
  updatedAtS: (i: number) => number,
  opts: { revertBelow?: number } = {},
) {
  const round = (i: number) =>
    [
      proxyId(BigInt(i)),
      BigInt((2500 + i) * 1e8),
      0n,
      BigInt(updatedAtS(i)),
      proxyId(BigInt(i)),
    ] as const
  const multicall = vi.fn(async ({ contracts }: { contracts: { args: readonly [bigint] }[] }) =>
    contracts.map((c) => {
      const id = c.args[0]
      expect(id >> 64n).toBe(PHASE)
      const i = Number(id & ((1n << 64n) - 1n))
      if (i < 1 || i > n || (opts.revertBelow !== undefined && i < opts.revertBelow)) {
        return { status: 'failure' as const, error: new Error('reverted') }
      }
      return { status: 'success' as const, result: round(i) }
    }),
  )
  const client = {
    readContract: vi.fn(
      async ({ address, functionName }: { address: string; functionName: string }) => {
        expect(address).toBe(CHAINLINK_ETH_USD.proxy)
        expect(functionName).toBe('latestRoundData')
        return round(n)
      },
    ),
    multicall,
  } as unknown as PublicClient
  return { client, multicall }
}

describe('readChainlinkHourly', () => {
  // Heartbeat-only: round i updated at H − (n − i)·1h − 10 min; the newest is 30 min old.
  const n = 200
  const hb = (i: number) => (H - (n - i) * HOUR_MS) / 1000 - 600

  it('samples the answer in force at each hour end, walking back in batches', async () => {
    const { client, multicall } = chainlinkClient(n, hb)
    const r = await readChainlinkHourly(client, NOW, 50, { batch: 16 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const { points, latest, partial, roundsRead } = r.data
    expect(points).toHaveLength(50)
    expect(points[49].t).toBe(H)
    // Round n is updated 10 min before H, so it is in force at H.
    expect(points[49].v).toBe(2500 + n)
    expect(points[48].v).toBe(2500 + n - 1)
    expect(points[0].v).toBe(2500 + n - 49)
    expect(points.every((p) => p.v !== null)).toBe(true)
    expect(partial).toBeNull()
    expect(latest).toEqual({
      roundId: proxyId(BigInt(n)).toString(),
      answer: 2500 + n,
      updatedAtMs: hb(n) * 1000,
    })
    // 50 hour ends need the round at or before the first one: 50 rounds + the latest.
    expect(roundsRead).toBeGreaterThanOrEqual(50)
    expect(roundsRead).toBeLessThanOrEqual(51)
    expect(multicall.mock.calls.length).toBe(Math.ceil(50 / 16))
  })

  it('stops at the phase start and leaves the earlier hours null', async () => {
    const { client } = chainlinkClient(20, (i) => (H - (20 - i) * HOUR_MS) / 1000 - 600)
    const r = await readChainlinkHourly(client, NOW, 50)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.partial).toBe('phaseStart')
    expect(r.data.roundsRead).toBe(20)
    expect(r.data.points.filter((p) => p.v !== null)).toHaveLength(20)
    expect(r.data.points[29].v).toBeNull()
    expect(r.data.oldestRoundMs).toBe(H - 19 * HOUR_MS - 600_000)
  })

  it('a reverting round is a phase boundary', async () => {
    const { client } = chainlinkClient(n, hb, { revertBelow: n - 10 })
    const r = await readChainlinkHourly(client, NOW, 50)
    expect(r.ok && r.data.partial).toBe('phaseStart')
    expect(r.ok && r.data.roundsRead).toBe(11)
  })

  it('caps the rounds read and says so', async () => {
    // A round every minute: 50h would need ~3,000 rounds.
    const { client } = chainlinkClient(5000, (i) => NOW / 1000 - (5000 - i) * 60)
    const r = await readChainlinkHourly(client, NOW, 50, { maxRounds: 600 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.partial).toBe('roundCap')
    expect(r.data.roundsRead).toBe(600)
    expect(r.data.points.at(-1)?.v).not.toBeNull()
    expect(r.data.points[0].v).toBeNull()
  })

  it('keeps what it read when a batch times out mid-walk', async () => {
    const { client, multicall } = chainlinkClient(n, hb)
    const normal = multicall.getMockImplementation()
    if (!normal) throw new Error('no mock implementation')
    // The first batch answers, the second never does.
    multicall.mockImplementationOnce(normal).mockImplementationOnce(() => new Promise(() => {}))
    const r = await readChainlinkHourly(client, NOW, 50, { batch: 8, timeoutMs: 50 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.partial).toBe('timeout')
    expect(r.data.roundsRead).toBe(9)
    expect(r.data.points.at(-1)?.v).toBe(2500 + n)
  })

  it('fails, never throws, when latestRoundData fails', async () => {
    const client = {
      readContract: vi.fn(async () => {
        throw new Error('execution reverted at https://rpc.example/secret')
      }),
      multicall: vi.fn(),
    } as unknown as PublicClient
    const r = await readChainlinkHourly(client, NOW)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).not.toContain('secret')
  })
})
