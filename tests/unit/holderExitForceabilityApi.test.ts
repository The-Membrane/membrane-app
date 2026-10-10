import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { readMatrix } = vi.hoisted(() => ({ readMatrix: vi.fn() }))
vi.mock('@/scripts/research/holder-exit-forceability-matrix.mjs', () => ({
  readVerifiedHolderExitForceabilityMatrix: readMatrix,
}))

const destination = `0x${'a'.repeat(40)}`
const otherDestination = `0x${'b'.repeat(40)}`
const routeKey = 'USDC → VaultV2 [USDC]'
const row = {
  routeKey,
  destination,
  originalAsset: `0x${'c'.repeat(40)}`,
  mechanism: 'atomic',
  directIssueBaseline: true,
  directIssueCellObservations: 2,
  measuredDirectBaselineCellObservations: 3,
  historicalDirectFinalAssetPayoutTransactions: 5,
  historicalStableSimulatedReverts: [
    {
      anchorBlock: 25400000,
      anchorAtUtc: '2026-06-26T06:25:47.000Z',
      qLabel: 'fixed_10k',
      sampledHours: [0, 1, 4, 24, 48, 168],
      provenance: 'saved_cell_disk_integrity_only',
      privateHolder: 'secret',
    },
  ],
  stageIssue: false,
  stageIssueObservations: 0,
  terminalSameEpisodeFinalAssetPaidProof: false,
  terminalSameEpisodeFinalAssetPaidProofs: 0,
  historicalReceiptCohort: null,
  historicalIntermediateQueue: null,
  historicalPublicConversionQuote: null,
  observedRequestToPayoutSeconds: [],
  calibratedImpairmentDuration: false,
  prospectiveCalibration: false,
  holderExecutableExit: false,
  forecastValidated: false,
  reasons: ['impairment_duration_uncalibrated'],
  privateHolder: `0x${'d'.repeat(40)}`,
  privateQ: '123456789',
}
const matrix = {
  manifestSha256: 'manifest-sha',
  mechanismVersion: 'v1',
  summary: {
    routeGroups: 25,
    exactSubjects: 67,
    subjectsWithMeasuredDirectBaseline: 33,
    subjectsWithHistoricalDirectFinalAssetPayout: 3,
    historicalDirectFinalAssetPayoutTransactions: 10,
    subjectsWithStageIssue: 8,
    subjectsWithSameEpisodeFinalAssetPaidProof: 0,
    subjectsWithHistoricalReceiptCohort: 0,
    historicalSameReceiptHolderPaidClaims: 0,
    subjectsWithHistoricalPublicConversionQuote: 0,
    subjectsWithCalibratedImpairmentDuration: 0,
    subjectsWithProspectiveCalibration: 0,
    privateDebug: 'should-not-leak',
  },
  subjects: [row, { ...row, destination: otherDestination }],
  privateRosterNote: 'should-not-leak',
}

async function request(
  query: Record<string, unknown> = { routeKey, destination },
  options: {
    method?: string
    remote?: string
    host?: string
    origin?: string
    fetchSite?: string
  } = {},
) {
  const { default: handler } = await import('@/pages/api/carry/holder-exit-forceability')
  let code = 0
  let body: Record<string, unknown> | null = null
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
      query,
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

describe('local exact-subject holder exit forceability API', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'development')
    readMatrix.mockReset().mockResolvedValue(matrix)
  })
  afterEach(() => vi.unstubAllEnvs())

  it('returns one exact row, bounded summary, and no holder/Q or roster leakage', async () => {
    const first = await request()
    expect(first.code).toBe(200)
    expect(first.headers['Cache-Control']).toBe('no-store')
    expect(first.body).toMatchObject({
      status: 'available',
      routeKey,
      destination,
      manifestSha256: 'manifest-sha',
      mechanismVersion: 'v1',
      forecastValidated: false,
      holderExecutableExit: false,
      summary: { routeGroups: 25, exactSubjects: 67 },
      subject: {
        mechanism: 'atomic',
        directIssueCellObservations: 2,
        measuredDirectBaselineCellObservations: 3,
        historicalDirectFinalAssetPayoutTransactions: 5,
        historicalStableSimulatedReverts: [
          { anchorBlock: 25400000, anchorAtUtc: '2026-06-26T06:25:47.000Z' },
        ],
        calibratedImpairmentDuration: false,
      },
    })
    const json = JSON.stringify(first.body)
    expect(json).not.toContain(row.privateHolder)
    expect(json).not.toContain(row.privateQ)
    expect(json).not.toContain('secret')
    expect(json).not.toContain(otherDestination)
    expect(json).not.toContain('should-not-leak')
    expect((await request()).code).toBe(200)
    expect(readMatrix).toHaveBeenCalledTimes(1)
  })

  it('returns a historical public quote without promoting it to a paid exit', async () => {
    const quote = {
      finalAsset: `0x${'e'.repeat(40)}`,
      cutoffBlock: 26107302,
      sizes: [{ usdatRaw: '1000000000000', ausdQuotedRaw: '999552915040' }],
      evidenceSha256: 'f'.repeat(64),
    }
    readMatrix.mockResolvedValueOnce({
      ...matrix,
      summary: { ...matrix.summary, subjectsWithHistoricalPublicConversionQuote: 1 },
      subjects: [{ ...row, historicalPublicConversionQuote: quote }],
    })
    const result = await request()
    expect(result.code).toBe(200)
    expect(result.body).toMatchObject({
      forecastValidated: false,
      summary: { subjectsWithHistoricalPublicConversionQuote: 1 },
      subject: {
        historicalPublicConversionQuote: quote,
        terminalSameEpisodeFinalAssetPaidProofs: 0,
      },
    })
  })

  it('keeps a historical staged receipt cohort distinct from prospective paid episodes', async () => {
    readMatrix.mockResolvedValueOnce({
      ...matrix,
      summary: {
        ...matrix.summary,
        subjectsWithHistoricalReceiptCohort: 1,
        historicalSameReceiptHolderPaidClaims: 89,
      },
      subjects: [
        {
          ...row,
          mechanism: 'staged',
          terminalSameEpisodeFinalAssetPaidProofs: 0,
          historicalReceiptCohort: {
            mintedReceipts: 96,
            firstEligibleHolderClaimSuccesses: 96,
            sameReceiptHolderPaidClaims: 89,
            openCensoredReceipts: 7,
            escrowEvidenceSha256: 'a'.repeat(64),
            boundaryEvidenceSha256: 'b'.repeat(64),
            payoutEvidenceSha256: 'c'.repeat(64),
          },
        },
      ],
    })
    const result = await request()
    expect(result.code).toBe(200)
    expect(result.body).toMatchObject({
      summary: { historicalSameReceiptHolderPaidClaims: 89 },
      subject: {
        terminalSameEpisodeFinalAssetPaidProofs: 0,
        historicalReceiptCohort: { mintedReceipts: 96, sameReceiptHolderPaidClaims: 89 },
        forecastValidated: false,
      },
    })
  })

  it('returns intermediate USDat queue evidence without promoting it to a final paid exit', async () => {
    readMatrix.mockResolvedValueOnce({
      ...matrix,
      subjects: [
        {
          ...row,
          mechanism: 'staged',
          terminalSameEpisodeFinalAssetPaidProofs: 0,
          historicalIntermediateQueue: {
            intermediateAsset: row.originalAsset,
            cutoffBlock: 26107302,
            requests: 146,
            processed: 106,
            paidIntermediate: 77,
            processedUnclaimed: 29,
            pendingCensored: 40,
            pendingAboveCurrentLimit: 40,
            pendingBeforeUpgrade: 34,
            pendingAfterUpgrade: 6,
            processingWithin24h: {
              horizonSeconds: 86400,
              confirmedProcessed: 87,
              possibleProcessed: 89,
              censoredBeforeHorizon: 2,
            },
          },
          latestPendingTicketObservation: {
            sourceCutoffBlock: 26107302,
            block: 26109183,
            blockTime: 1790998871,
            cohort: 40,
            stillRequested: 40,
            noLongerRequested: 0,
            priceGated: 40,
            quoteEligible: 0,
            medianElapsedSeconds: 402000,
            atLeastSevenDays: 15,
            evidenceSha256: 'a'.repeat(64),
          },
        },
      ],
    })
    const result = await request()
    expect(result.code).toBe(200)
    expect(result.body).toMatchObject({
      subject: {
        historicalIntermediateQueue: {
          paidIntermediate: 77,
          pendingAboveCurrentLimit: 40,
          processingWithin24h: {
            horizonSeconds: 86400,
            confirmedProcessed: 87,
            possibleProcessed: 89,
            censoredBeforeHorizon: 2,
          },
        },
        latestPendingTicketObservation: {
          block: 26109183,
          priceGated: 40,
          cohort: 40,
          medianElapsedSeconds: 402000,
          atLeastSevenDays: 15,
        },
        terminalSameEpisodeFinalAssetPaidProofs: 0,
        forecastValidated: false,
      },
    })
  })

  it('distinguishes an unknown exact route+destination and retries after verification failure', async () => {
    expect((await request({ routeKey, destination: `0x${'e'.repeat(40)}` })).body).toEqual({
      status: 'unavailable',
      reason: 'subject_not_tracked',
    })
    vi.resetModules()
    readMatrix
      .mockReset()
      .mockRejectedValueOnce(new Error('private local path'))
      .mockResolvedValue(matrix)
    expect(await request()).toMatchObject({
      code: 503,
      body: { status: 'unavailable', reason: 'verification_unavailable' },
    })
    expect((await request()).code).toBe(200)
    expect(readMatrix).toHaveBeenCalledTimes(2)
  })

  it('blocks nonlocal requests before the verifier, including spoofed local headers', async () => {
    expect((await request(undefined, { remote: '203.0.113.4' })).code).toBe(503)
    expect((await request(undefined, { host: 'example.com' })).code).toBe(503)
    expect((await request(undefined, { origin: 'https://example.com' })).code).toBe(503)
    expect((await request(undefined, { origin: 'http://localhost:3006' })).code).toBe(503)
    expect((await request(undefined, { fetchSite: 'cross-site' })).code).toBe(503)
    vi.stubEnv('NODE_ENV', 'production')
    expect((await request()).code).toBe(503)
    expect(readMatrix).not.toHaveBeenCalled()
  })

  it('accepts each actual loopback host and rejects invalid ports and control characters', async () => {
    expect((await request(undefined, { host: '127.0.0.1:3005' })).code).toBe(200)
    expect((await request(undefined, { host: '[::1]:3005', remote: '::1' })).code).toBe(200)
    expect((await request(undefined, { host: 'localhost:99999' })).code).toBe(503)
    expect((await request({ routeKey: routeKey + '\n', destination })).code).toBe(400)
  })

  it('rejects malformed or extra query fields and other methods before verification', async () => {
    for (const query of [
      { routeKey, destination, owner: `0x${'f'.repeat(40)}` },
      { routeKey: [routeKey], destination },
      { routeKey: ` ${routeKey}`, destination },
      { routeKey, destination: 'not-an-address' },
    ])
      expect((await request(query)).code).toBe(400)
    const post = await request(undefined, { method: 'POST' })
    expect(post.code).toBe(405)
    expect(post.headers.Allow).toBe('GET')
    expect(readMatrix).not.toHaveBeenCalled()
  })
})
