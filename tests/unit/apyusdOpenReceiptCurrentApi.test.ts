import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { observe } = vi.hoisted(() => ({ observe: vi.fn() }))
vi.mock('@/lib/carry/observeApyUsdOpenReceiptCurrent', () => ({
  observeApyUsdOpenReceiptCurrent: observe,
}))

const NOW = Date.parse('2026-10-03T12:00:00.000Z')
const subjects = Array.from({ length: 7 }, (_, index) => ({
  tokenId: String(881 + index),
  receiptEscrowRaw: '1000',
  holder: `0x${'a'.repeat(40)}`,
}))
const observation = () => ({
  observationStatus: 'unsealed',
  scope: 'current_status_of_frozen_historical_open_receipts',
  prospectiveQForecast: false,
  holderCodeChecked: true,
  origins: ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'],
  block: {
    number: 26114032,
    hash: `0x${'d'.repeat(64)}`,
    timestamp: Math.floor(Date.now() / 1000) - 600,
  },
  observedAtUtc: new Date(Date.now()).toISOString(),
  subjects: subjects.map((subject) => ({ ...subject })),
  proofs: subjects.map(({ tokenId }) => ({
    tokenId,
    status: 'same_holder',
    isClaimable: true,
    claimStatus: 'success',
    claimAmountRaw: '1000',
    holderCodeStatus: 'no_code' as const,
  })),
  privateRpcUrl: 'https://secret.invalid/private',
})

async function request(
  options: {
    method?: string
    remote?: string
    host?: string
    origin?: string
    fetchSite?: string
    query?: Record<string, string>
  } = {},
) {
  const { default: handler } = await import('@/pages/api/carry/apyusd-open-receipt-current')
  let code = 0
  let body: Record<string, unknown> = {}
  const headers: Record<string, string> = {}
  const res = {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value
    }),
    status: vi.fn((value: number) => {
      code = value
      return res
    }),
    json: vi.fn((value: Record<string, unknown>) => {
      body = value
      return res
    }),
  }
  await handler(
    {
      method: options.method ?? 'GET',
      query: options.query ?? {},
      headers: {
        host: options.host ?? 'localhost:3005',
        ...(options.origin ? { origin: options.origin } : {}),
        ...(options.fetchSite ? { 'sec-fetch-site': options.fetchSite } : {}),
      },
      socket: { remoteAddress: options.remote ?? '127.0.0.1' },
    } as never,
    res as never,
  )
  return { code, body, headers }
}

describe('local ApyUSD open receipt current API', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    vi.stubEnv('NODE_ENV', 'development')
    observe.mockReset().mockImplementation(async () => observation())
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('returns only the bounded fresh seven-receipt summary', async () => {
    const result = await request()
    expect(result.code).toBe(200)
    expect(result.headers['Cache-Control']).toBe('no-store')
    expect(result.body).toEqual({
      status: 'fresh',
      scope: 'historical_open_receipts',
      prospectiveQForecast: false,
      block: observation().block,
      observedAtUtc: new Date(NOW).toISOString(),
      openReceiptCount: 7,
      noCurrentOwnerCount: 0,
      holderChangedCount: 0,
      claimSimulationPassCount: 7,
      fullEscrowSimulationCount: 7,
      noCodeHolderCount: 7,
      delegatedEoaHolderCount: 0,
      contractHolderCount: 0,
      sourceHosts: ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'],
    })
    expect(JSON.stringify(result.body)).not.toContain(subjects[0].holder)
    expect(JSON.stringify(result.body)).not.toContain('secret.invalid')
  })

  it('counts exact full escrow checks separately from positive partial checks', async () => {
    const row = observation()
    row.proofs[0].claimAmountRaw = '999'
    row.proofs[1].isClaimable = true
    row.proofs[1].claimStatus = 'evm_revert'
    row.proofs[1].claimAmountRaw = null as never
    observe.mockResolvedValueOnce(row)
    expect((await request()).body).toMatchObject({
      openReceiptCount: 7,
      claimSimulationPassCount: 6,
      fullEscrowSimulationCount: 5,
      noCodeHolderCount: 7,
      delegatedEoaHolderCount: 0,
      contractHolderCount: 0,
    })
  })

  it('keeps transferred and absent receipts unresolved instead of hiding the other claim checks', async () => {
    const row = observation()
    row.proofs[0] = {
      tokenId: subjects[0].tokenId,
      status: 'holder_changed',
      currentOwner: `0x${'2'.repeat(40)}`,
      holderCodeStatus: 'no_code',
    } as never
    row.proofs[1] = {
      tokenId: subjects[1].tokenId,
      status: 'no_current_owner',
      holderCodeStatus: 'no_code',
    } as never
    observe.mockResolvedValueOnce(row)
    expect((await request()).body).toMatchObject({
      openReceiptCount: 5,
      noCurrentOwnerCount: 1,
      holderChangedCount: 1,
      claimSimulationPassCount: 5,
      fullEscrowSimulationCount: 5,
      noCodeHolderCount: 5,
    })
  })

  it('keeps delegated EOAs and contract-held simulations separate from no-code holders', async () => {
    const row = observation()
    row.proofs[0].holderCodeStatus = 'eip7702_delegated'
    row.proofs[1].holderCodeStatus = 'contract_code'
    observe.mockResolvedValueOnce(row)
    expect((await request()).body).toMatchObject({
      openReceiptCount: 7,
      claimSimulationPassCount: 7,
      fullEscrowSimulationCount: 7,
      noCodeHolderCount: 5,
      delegatedEoaHolderCount: 1,
      contractHolderCount: 1,
    })
  })

  it('rejects remote, cloud, cross-origin, non-GET and query requests before observation', async () => {
    expect((await request({ remote: '203.0.113.2' })).code).toBe(503)
    expect((await request({ host: 'example.com' })).code).toBe(503)
    expect((await request({ origin: 'https://example.com' })).code).toBe(503)
    expect((await request({ fetchSite: 'cross-site' })).code).toBe(503)
    vi.stubEnv('VERCEL', '1')
    expect((await request()).code).toBe(503)
    vi.stubEnv('VERCEL', undefined)
    expect((await request({ method: 'POST' })).code).toBe(405)
    expect((await request({ query: { tokenId: '881' } })).code).toBe(400)
    expect(observe).not.toHaveBeenCalled()
  })

  it('single-flights concurrent requests, caches at most 30 seconds, and retries failures', async () => {
    let finish!: (row: ReturnType<typeof observation>) => void
    observe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const first = request()
    const second = request()
    await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(1))
    finish(observation())
    expect((await first).code).toBe(200)
    expect((await second).code).toBe(200)
    expect((await request()).code).toBe(200)
    expect(observe).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(30_001)
    expect((await request()).code).toBe(200)
    expect(observe).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(30_001)
    observe.mockRejectedValueOnce(Error('secret RPC URL'))
    const failed = await request()
    expect(failed.code).toBe(503)
    expect(JSON.stringify(failed.body)).not.toContain('secret')
    expect((await request()).code).toBe(200)
    expect(observe).toHaveBeenCalledTimes(4)
  })

  it.each([
    [
      'unproven holder origin',
      (row: ReturnType<typeof observation>) => {
        row.holderCodeChecked = false
      },
    ],
    [
      'missing per-holder code evidence',
      (row: ReturnType<typeof observation>) => {
        row.proofs[0].holderCodeStatus = 'unknown' as never
      },
    ],
    [
      'short cohort',
      (row: ReturnType<typeof observation>) => {
        row.subjects = row.subjects.slice(0, 6)
      },
    ],
    [
      'duplicate subject',
      (row: ReturnType<typeof observation>) => {
        row.subjects[1] = row.subjects[0]
      },
    ],
    [
      'malformed claim',
      (row: ReturnType<typeof observation>) => {
        row.proofs[0].claimAmountRaw = 'oops'
      },
    ],
    [
      'excessive claim',
      (row: ReturnType<typeof observation>) => {
        row.proofs[0].claimAmountRaw = '1001'
      },
    ],
    [
      'wrong origin',
      (row: ReturnType<typeof observation>) => {
        row.origins[0] = 'evil.invalid'
      },
    ],
    [
      'stale block',
      (row: ReturnType<typeof observation>) => {
        row.block.timestamp = NOW / 1000 - 46 * 60
      },
    ],
    [
      'stale observation',
      (row: ReturnType<typeof observation>) => {
        row.observedAtUtc = new Date(NOW - 31_000).toISOString()
      },
    ],
  ])('fails closed on %s', async (_label, mutate) => {
    const row = observation()
    mutate(row)
    observe.mockResolvedValueOnce(row)
    const result = await request()
    expect(result.code).toBe(503)
    expect(result.body).toEqual({ status: 'unavailable', reason: 'observation_unavailable' })
    expect((await request()).code).toBe(200)
    expect(observe).toHaveBeenCalledTimes(2)
  })
})
