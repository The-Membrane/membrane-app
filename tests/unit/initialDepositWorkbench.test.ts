import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadInitialDepositForecast,
  loadRouteForecastWithLiveCurrent,
} from '@/components/Carry/ForecastWorkbench'
import { NOW, initialDepositUiFixture } from './initialDepositUiFixture'

afterEach(() => vi.restoreAllMocks())
describe('actual Workbench forecast loaders', () => {
  it('posts native D and Q as separate principals without display asset metadata', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const f = initialDepositUiFixture({ D: '2000001', Q: '3000002' })
    const baseline = {
      routeKey: f.question.routeKey,
      destination: f.question.destination,
      amountUnits: f.props.requestedAmount,
      horizonHours: 24 as const,
      payoutAsset: f.question.asset,
      payoutAssetDecimals: 6,
    }
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => f.body })
    const result = await loadInitialDepositForecast(
      baseline,
      f.question,
      new AbortController().signal,
      fetcher,
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, options] = fetcher.mock.calls[0]
    expect(url).toBe('/api/carry/forecast')
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body)).toEqual({
      mode: 'initial_deposit',
      routeKey: f.question.routeKey,
      destination: f.question.destination,
      depositAssetsRaw: '2000001',
      plannedExitAssetsRaw: '3000002',
      horizonHours: 24,
    })
    expect(result?.issue?.question).toEqual(f.question)
    expect(result?.baseline.forecast.amountUnits).toBe(3.000002)
  })
  it('does not deliver an aborted deposit response or accept a relabeled baseline', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const f = initialDepositUiFixture()
    const baseline = {
      routeKey: f.question.routeKey,
      destination: f.question.destination,
      amountUnits: f.props.requestedAmount,
      horizonHours: 24 as const,
      payoutAsset: f.question.asset,
    }
    const controller = new AbortController()
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        controller.abort()
        return f.body
      },
    })
    expect(
      await loadInitialDepositForecast(baseline, f.question, controller.signal, fetcher),
    ).toBeNull()
    const other = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...f.body, destination: `0x${'b'.repeat(40)}` }),
    })
    await expect(
      loadInitialDepositForecast(baseline, f.question, new AbortController().signal, other),
    ).rejects.toThrow('initial_deposit_baseline_mismatch')
  })
  it('retains baseline history if a native optional projection is unavailable', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const f = initialDepositUiFixture()
    const baseline = {
      routeKey: f.question.routeKey,
      destination: f.question.destination,
      amountUnits: f.props.requestedAmount,
      horizonHours: 24 as const,
      payoutAsset: f.question.asset,
    }
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...f.body,
        initialDepositProjection: {
          status: 'unavailable',
          reason: 'optional_native_facts_failed',
        },
      }),
    })
    const result = await loadInitialDepositForecast(
      baseline,
      f.question,
      new AbortController().signal,
      fetcher,
    )
    expect(result?.baseline.forecast.claim).toBe('aggregate_cash_proxy_only')
    expect(result?.issue).toBeNull()
  })
  it('keeps legacy Exit loader GET query fields and archive delivery unchanged', async () => {
    const question = {
      routeKey: 'unsupported pilot',
      destination: `0x${'c'.repeat(40)}`,
      amountUnits: '4',
      horizonHours: 48 as const,
      payoutAsset: null,
    }
    const body = {
      routeKey: question.routeKey,
      destination: question.destination,
      source: 'prospective_finalized_observations',
      forecast: { claim: 'aggregate_cash_proxy_only', amountUnits: 4, horizonHours: 48 },
    }
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => body })
    const deliver = vi.fn()
    expect(
      await loadRouteForecastWithLiveCurrent(
        question,
        new AbortController().signal,
        deliver,
        fetcher,
      ),
    ).toBeNull()
    expect(deliver).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, options] = fetcher.mock.calls[0]
    const query = new URL(url, 'https://offline.invalid').searchParams
    expect(Object.fromEntries(query)).toEqual({
      routeKey: question.routeKey,
      destination: question.destination,
      amountUnits: '4',
      horizonHours: '48',
    })
    expect(options.method).toBeUndefined()
    expect(options.body).toBeUndefined()
  })
})
