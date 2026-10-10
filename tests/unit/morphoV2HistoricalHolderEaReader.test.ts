import { afterEach, describe, expect, it, vi } from 'vitest'
import { readMorphoV2HistoricalHolderEaOrigin } from '@/lib/carry/morphoV2HistoricalHolderEaReader.server'
import {
  createMorphoV2HistoricalHolderEaFixture,
  historicalEaUint,
} from './fixtures/morphoV2HistoricalHolderEaFixture'

describe('optional native historical full-S reader', () => {
  afterEach(() => vi.useRealTimers())
  it.each(['USDC', 'USDT'] as const)(
    'reads %s full S at each reviewed EIP1898 hash with ordered actual clocks',
    async (asset) => {
      const { expected, pair, anchors, started } = createMorphoV2HistoricalHolderEaFixture(asset)
      let tick = started
      const request = vi.fn().mockResolvedValue(historicalEaUint(13n))
      const observation = await readMorphoV2HistoricalHolderEaOrigin(
        { request },
        expected.currentSource,
        { profile: expected.profile, sharesRaw: expected.sharesRaw, now: () => tick++ },
      )
      expect(observation).not.toBeNull()
      expect(request).toHaveBeenCalledTimes(anchors.length)
      expect(request.mock.calls.map(([wire]) => wire)).toEqual(
        pair.origins[0].observation.traces.map((t) => ({ method: 'eth_call', params: t.params })),
      )
      expect(observation!.traces.map((t) => t.source)).toEqual(anchors.map((p) => p.source))
      let prior = Date.parse(observation!.startedAtUtc)
      for (const trace of observation!.traces) {
        expect(Date.parse(trace.startedAtUtc)).toBeGreaterThanOrEqual(prior)
        expect(Date.parse(trace.completedAtUtc)).toBeGreaterThanOrEqual(
          Date.parse(trace.startedAtUtc),
        )
        prior = Date.parse(trace.completedAtUtc)
      }
      expect(Date.parse(observation!.readAtUtc)).toBeGreaterThanOrEqual(prior)
    },
  )
  it('snapshots source, options and request params before awaits', async () => {
    const { expected, started } = createMorphoV2HistoricalHolderEaFixture()
    const options = { profile: expected.profile, sharesRaw: expected.sharesRaw, now: () => started }
    const snapshot = structuredClone(expected.currentSource)
    let release!: (value: string) => void
    const request = vi
      .fn()
      .mockImplementationOnce((wire) => {
        wire.params[0].data = '0x'
        return new Promise((resolve) => {
          release = resolve
        })
      })
      .mockResolvedValue(historicalEaUint(77n))
    const pending = readMorphoV2HistoricalHolderEaOrigin(
      { request },
      expected.currentSource,
      options,
    )
    await Promise.resolve()
    expected.currentSource.blockHash = `0x${'c'.repeat(64)}`
    options.sharesRaw = '1'
    release(historicalEaUint(77n))
    const observation = await pending
    expect(observation!.currentSource).toEqual(snapshot)
    expect(observation!.sharesRaw).not.toBe('1')
    expect(observation!.traces[0].params[0].data).not.toBe('0x')
  })
  it.each(['clone', 'stale', 'deadline', 'shares'] as const)(
    'issues no calls for invalid %s inputs',
    async (invalid) => {
      const { expected, started } = createMorphoV2HistoricalHolderEaFixture()
      const request = vi.fn()
      const options = {
        profile: expected.profile,
        sharesRaw: expected.sharesRaw,
        deadlineMs: 12000,
        now: () => started,
      }
      if (invalid === 'clone') options.profile = structuredClone(expected.profile)
      if (invalid === 'stale') options.now = () => started + 2 * 60 * 60 * 1000 + 1
      if (invalid === 'deadline') options.deadlineMs = 12001
      if (invalid === 'shares') options.sharesRaw = '01'
      expect(
        await readMorphoV2HistoricalHolderEaOrigin({ request }, expected.currentSource, options),
      ).toBeNull()
      expect(request).not.toHaveBeenCalled()
    },
  )
  it('drops a failed/partial archive origin without retries or further calls', async () => {
    const { expected, started } = createMorphoV2HistoricalHolderEaFixture()
    const request = vi
      .fn()
      .mockResolvedValueOnce(historicalEaUint(42n))
      .mockRejectedValueOnce(new Error('archive unavailable'))
    expect(
      await readMorphoV2HistoricalHolderEaOrigin({ request }, expected.currentSource, {
        profile: expected.profile,
        sharesRaw: expected.sharesRaw,
        now: () => started,
      }),
    ).toBeNull()
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('drops malformed ABI and backwards clocks', async () => {
    const { expected, started } = createMorphoV2HistoricalHolderEaFixture()
    const malformed = vi.fn().mockResolvedValue('0x')
    expect(
      await readMorphoV2HistoricalHolderEaOrigin({ request: malformed }, expected.currentSource, {
        profile: expected.profile,
        sharesRaw: expected.sharesRaw,
        now: () => started,
      }),
    ).toBeNull()
    expect(malformed).toHaveBeenCalledTimes(1)
    let reads = 0
    const request = vi.fn().mockResolvedValue(historicalEaUint(1n))
    expect(
      await readMorphoV2HistoricalHolderEaOrigin({ request }, expected.currentSource, {
        profile: expected.profile,
        sharesRaw: expected.sharesRaw,
        now: () => started + (reads++ < 3 ? 1 : 0),
      }),
    ).toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('returns by its deadline and never launches another call after a timed-out request settles', async () => {
    vi.useFakeTimers()
    const { expected, started } = createMorphoV2HistoricalHolderEaFixture()
    let release!: (value: string) => void
    const request = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const pending = readMorphoV2HistoricalHolderEaOrigin({ request }, expected.currentSource, {
      profile: expected.profile,
      sharesRaw: expected.sharesRaw,
      deadlineMs: 5,
      now: () => started,
    })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(6)
    expect(await pending).toBeNull()
    release(historicalEaUint(1n))
    await Promise.resolve()
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('drops a result that crosses the capture deadline instead of reading further anchors', async () => {
    const { expected, started } = createMorphoV2HistoricalHolderEaFixture()
    let tick = started
    const request = vi.fn().mockImplementation(async () => {
      tick += 13_000
      return historicalEaUint(1n)
    })
    expect(
      await readMorphoV2HistoricalHolderEaOrigin({ request }, expected.currentSource, {
        profile: expected.profile,
        sharesRaw: expected.sharesRaw,
        now: () => tick,
      }),
    ).toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
  })
})
