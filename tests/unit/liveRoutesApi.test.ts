import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'

import { db } from '@/db'
import handler, {
  selectLatestGhoExactSpread,
  selectLatestGhoMatchedCapital,
  selectLatestUsdeExactSpread,
  selectLatestUsdeMatchedCapital,
  selectUsdePilotPair,
} from '@/pages/api/carry/live-routes'

vi.mock('@/db', () => ({ db: { execute: vi.fn() } }))

const capitalKey = 'USDe → Staked USDe [USDe]'
const spreadKey =
  '1:aave v3 core:0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2:0x4c9edd5852cd905f086c759e8383e09bff1e68b3:0x9d39a5de30e57443bff2a8307a4256c8797a3497'
const ghoSpreadKey =
  '1:aave v3:0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2:0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f:0xe1753f2e00940cc31213dd92013cf019dfe4ca1d'
const ghoLeg = {
  chainId: 1,
  borrowProtocol: 'Aave V3',
  borrowMarket: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
  borrowAsset: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
  destinationKind: 'ERC4626',
  destination: '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
}
const hash = (character: string) => `0x${character.repeat(64)}`
const time = (day: number) => `2026-09-${String(day).padStart(2, '0')}T23:59:00.000Z`
const measuredBorrowApy = 0.06526441888450002
const measuredYieldApy = 0.04804445599964633
const measuredSpread = -0.01721996288485369

function row(
  kind: 'matched_capital' | 'destination_tvl' | 'spread',
  day: number,
  block: number,
  blockHash: string,
) {
  const common = {
    route_key: kind === 'spread' ? spreadKey : capitalKey,
    kind,
    block,
    observed_at: time(day),
  }
  const capital = {
    measurement:
      'lesser_of_current_aave_usde_variable_debt_and_susde_holding_per_august_receipt_attested_wallet',
    claim: 'same_wallet_overlap_not_route_attributed_tvl_or_executable_exit',
    matchedUsde: '12.5',
    matchedRaw: '12500000000000000000',
    observedWalletCount: 25,
    completeWalletCount: 25,
    unknownWalletCount: 0,
    blockNumber: String(block),
    blockTimestamp: time(day),
    blockHash,
    artifactSha256: 'c'.repeat(64),
    manifestSha256: 'd'.repeat(64),
  }
  const destination = {
    measurement: 'destination_vault_total_assets_all_depositors',
    claim: 'all_depositor_vault_assets_not_route_tvl',
    totalAssetsUsde: '1000',
    totalAssetsRaw: '1000000000000000000000',
    observedWalletCount: 25,
    completeWalletCount: 25,
    unknownWalletCount: 0,
    blockNumber: String(block),
    blockTimestamp: time(day),
    blockHash,
    artifactSha256: 'c'.repeat(64),
    manifestSha256: 'd'.repeat(64),
  }
  const spread = {
    schemaVersion: 1,
    leg: {
      chainId: 1,
      borrowProtocol: 'Aave V3 Core',
      borrowMarket: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
      borrowAsset: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
      destination: '0x9d39a5de30e57443bff2a8307a4256c8797a3497',
      destinationKind: 'ERC4626',
    },
    variableDebtToken: '0x015396e1f286289ae23a762088e863b3ec465145',
    measurement: 'current_aave_variable_borrow_apy_vs_trailing_seven_day_susde_share_growth_apy',
    claim: 'modeled_two_leg_spread_not_cohort_realized_return',
    rateConvention: 'effective APY as decimal fraction; incentives, gas, and exit costs excluded',
    borrowApy: measuredBorrowApy,
    yieldApy: measuredYieldApy,
    spread: measuredSpread,
    currentBlockNumber: String(block),
    currentBlockHash: blockHash,
    currentBlockTimestamp: time(day),
    priorBlockNumber: String(block - 50000),
    priorBlockHash: hash('c'),
    priorBlockTimestamp: time(day - 7),
    lookbackSeconds: 604800,
    collectionStartedAt: new Date(Date.parse(time(day)) + 900_000).toISOString(),
    capturedAt: new Date(Date.parse(time(day)) + 901_284).toISOString(),
    collectionElapsedMs: 1284,
    ageSecondsAtCapture: 901,
    currentVariableBorrowRateRayRaw: '63223049050947805975539927',
    shareUnitRaw: '1000000000000000000',
    currentAssetsPerShareUnitRaw: '1250200054285871351',
    priorAssetsPerShareUnitRaw: '1249075441898321131',
    assetDecimals: 18,
    shareDecimals: 18,
    artifactSha256: 'e'.repeat(64),
    manifestSha256: 'f'.repeat(64),
  }
  return {
    ...common,
    data: kind === 'spread' ? spread : kind === 'destination_tvl' ? destination : capital,
  }
}

const complete = (day: number, block: number, blockHash = hash('a')) => [
  row('matched_capital', day, block, blockHash),
  row('destination_tvl', day, block, blockHash),
  row('spread', day, block, blockHash),
]

function ghoCapitalRow(day: number, block: number, blockHash = hash('a')) {
  return {
    route_key: 'GHO → sGho [GHO]',
    kind: 'matched_capital' as const,
    block,
    observed_at: time(day),
    data: {
      measurement: 'lesser_of_current_aave_gho_debt_and_sgho_holding_per_august_observed_wallet',
      sourceSha256: 'a0aee85535cb4c96f09d2f3bce3af3d2bcc9d1e2ee0156e24265111263c4cf63',
      borrowMarket: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
      borrowAsset: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
      destination: '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
      blockHash,
      receiptProofCount: 20,
      observedWalletCount: 20,
      completeWalletCount: 20,
      unknownWalletCount: 0,
      matchedRaw: '12500000000000000000',
      matchedGho: 12.5,
    },
  }
}

function ghoSpreadRow(day: number, block: number, blockHash = hash('a')) {
  return {
    route_key: ghoSpreadKey,
    kind: 'spread' as const,
    block,
    observed_at: time(day),
    data: {
      key: ghoSpreadKey,
      leg: ghoLeg,
      status: 'priced',
      blockNumber: String(block),
      blockHash,
      asOf: Date.parse(time(day)) / 1000,
      lookback: {
        seconds: 7 * 24 * 60 * 60,
        priorAt: Date.parse(time(day)) / 1000 - 7 * 24 * 60 * 60,
        priorBlockNumber: String(block - 50000),
      },
      rateConvention: 'effective APY, decimal fraction',
      borrowSource: 'Aave V3 currentVariableBorrowRate, nominal ray APR compounded per second',
      yieldSource:
        'ERC4626 convertToAssets share-price growth, realized trailing window; incentives excluded',
      borrowApy: 0.05,
      yieldApy: 0.07,
      spread: 0.02,
    },
  }
}

function response() {
  const state: { status: number; body: Record<string, any> | null } = { status: 0, body: null }
  const res = {
    setHeader: vi.fn(),
    status: vi.fn((status: number) => {
      state.status = status
      return res
    }),
    json: vi.fn((body: Record<string, any>) => {
      state.body = body
      return res
    }),
  }
  return { state, res }
}

describe('USDe daily capital/spread API pairing', () => {
  beforeEach(() => {
    vi.mocked(db.execute).mockReset()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('excludes future DB rows before ranking the bounded route/kind windows', async () => {
    vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never)
    const { state, res } = response()
    await handler({ method: 'GET' } as never, res as never)
    expect(state.status).toBe(200)
    const query = new PgDialect().sqlToQuery(vi.mocked(db.execute).mock.calls[0][0]).sql
    expect(query).toMatch(
      /FROM carry_route_hourly\s+WHERE status = 'ok'\s+AND observed_at <= NOW\(\)\s+AND \(\(route_key/,
    )
    expect(query).toMatch(/\) recent\s+WHERE ordinal <= 32/)
  })

  it('rejects independently collected legacy capital and spread blocks', () => {
    const rows = [
      row('matched_capital', 27, 26080000, hash('a')),
      row('destination_tvl', 27, 26080000, hash('a')),
      row('spread', 27, 26080004, hash('b')),
    ]
    expect(selectUsdePilotPair(rows).asOf).toBeNull()
    expect(selectUsdePilotPair(rows).matchedCapital).toBeNull()
    expect(selectLatestUsdeMatchedCapital(rows)?.block).toBe(26080000)
  })

  it('publishes a fixed-25 capital pair without manufacturing a same-block rate trio', async () => {
    const rows = [
      row('matched_capital', 28, 26087000, hash('b')),
      row('destination_tvl', 28, 26087000, hash('b')),
      row('spread', 27, 26080000, hash('a')),
    ]
    vi.mocked(db.execute).mockResolvedValue({ rows } as never)
    const { state, res } = response()
    await handler({ method: 'GET' } as never, res as never)
    expect(state.status).toBe(200)
    expect(state.body?.latestUsdeMatchedCapital).toEqual(
      expect.objectContaining({ block: 26087000, matchedUsde: '12.5' }),
    )
    expect(state.body?.latestUsdeExactSpread?.block).toBe(26080000)
    expect(state.body?.usdePilot.asOf).toBeNull()
  })

  it('keeps a genuine zero-capital pair visible as zero', () => {
    const rows = complete(28, 26087000, hash('b'))
    rows[0] = { ...rows[0], data: { ...rows[0].data, matchedRaw: '0', matchedUsde: '0' } }
    expect(selectLatestUsdeMatchedCapital(rows)).toEqual(
      expect.objectContaining({ block: 26087000, matchedUsde: '0' }),
    )
  })

  it('falls back past malformed newer capital or destination pairs', () => {
    const latest = complete(28, 26087000, hash('b'))
    const prior = complete(27, 26080000)
    const capitalCorruptions = [
      { claim: 'route_tvl' },
      { completeWalletCount: 24 },
      { observedWalletCount: 24 },
      { unknownWalletCount: 1 },
      { matchedRaw: '12500000000000000001' },
      { matchedUsde: 'bad' },
      { blockNumber: '26086999' },
      { blockHash: 'invalid' },
      { artifactSha256: 'invalid' },
    ]
    for (const corruption of capitalCorruptions) {
      const rows = [
        { ...latest[0], data: { ...latest[0].data, ...corruption } },
        latest[1],
        latest[2],
        ...prior,
      ]
      expect(selectLatestUsdeMatchedCapital(rows)?.block).toBe(26080000)
      expect(selectUsdePilotPair(rows).asOf?.block).toBe(26080000)
    }
    const wrongDestination = {
      ...latest[1],
      data: { ...latest[1].data, manifestSha256: 'e'.repeat(64) },
    }
    expect(selectLatestUsdeMatchedCapital([latest[0], wrongDestination, ...prior])?.block).toBe(
      26080000,
    )
    expect(
      selectUsdePilotPair([latest[0], wrongDestination, latest[2], ...prior]).asOf?.block,
    ).toBe(26080000)
  })

  it('does not publish future-dated capital over an older valid pair', () => {
    const current = complete(27, 26080000)
    const future = complete(28, 26087000, hash('b'))
    const beforeFuture = Date.parse(time(28)) - 1
    expect(selectLatestUsdeMatchedCapital([...future, ...current], beforeFuture)?.block).toBe(
      26080000,
    )
    expect(selectLatestUsdeMatchedCapital(future, beforeFuture)).toBeNull()
  })

  it('falls back from a future complete trio without hiding valid standalone daily legs', async () => {
    vi.setSystemTime(new Date('2026-09-28T12:00:00Z'))
    const older = complete(27, 26080000)
    const future = complete(28, 26087000, hash('b'))
    vi.mocked(db.execute).mockResolvedValue({ rows: [...future, ...older] } as never)
    const { state, res } = response()
    await handler({ method: 'GET' } as never, res as never)
    expect(state.status).toBe(200)
    expect(state.body?.usdePilot.asOf?.block).toBe(26080000)
    expect(state.body?.usdePilot.matchedCapital?.block).toBe(26080000)
    expect(state.body?.usdePilot.destinationVaultTvl?.block).toBe(26080000)
    expect(state.body?.usdePilot.exactSpread?.block).toBe(26080000)
    expect(state.body?.latestUsdeMatchedCapital?.block).toBe(26080000)
    expect(state.body?.latestUsdeExactSpread?.block).toBe(26080000)
    expect(selectUsdePilotPair(future).asOf).toBeNull()
    expect(selectLatestUsdeExactSpread(future)).toBeNull()
  })

  it('retains the prior complete reading through a partial DB write, including midnight', async () => {
    const prior = complete(27, 26080000)
    const partial = [row('matched_capital', 28, 26087000, hash('b'))]
    vi.mocked(db.execute).mockResolvedValue({ rows: [...partial, ...prior] } as never)
    const { state, res } = response()
    await handler({ method: 'GET' } as never, res as never)
    expect(state.status).toBe(200)
    expect(state.body?.usdePilot.asOf).toEqual({
      block: 26080000,
      blockHash: hash('a'),
      observedAt: time(27),
    })
    expect(state.body?.usdePilot.matchedCapital.block).toBe(26080000)
    expect(state.body?.usdePilot.destinationVaultTvl.block).toBe(26080000)
    expect(state.body?.usdePilot.exactSpread.block).toBe(26080000)
    expect(state.body?.latestUsdeExactSpread.block).toBe(26080000)
  })

  it('publishes a newer valid rate independently when capital/TVL are missing', async () => {
    const recentRate = row('spread', 28, 26087000, hash('b'))
    vi.mocked(db.execute).mockResolvedValue({
      rows: [recentRate, ...complete(27, 26080000)],
    } as never)
    const { state, res } = response()
    await handler({ method: 'GET' } as never, res as never)
    expect(state.status).toBe(200)
    expect(state.body?.latestUsdeExactSpread).toEqual(
      expect.objectContaining({ block: 26087000, observedAt: time(28), spread: measuredSpread }),
    )
    expect(state.body?.usdePilot.asOf.block).toBe(26080000)
    expect(state.body?.usdePilot.exactSpread.block).toBe(26080000)
  })

  it('publishes a valid rate when no capital/TVL pair exists at all', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z'))
    try {
      vi.mocked(db.execute).mockResolvedValue({
        rows: [row('spread', 28, 26087000, hash('b'))],
      } as never)
      const { state, res } = response()
      await handler({ method: 'GET' } as never, res as never)
      expect(state.body?.latestUsdeExactSpread.block).toBe(26087000)
      expect(state.body?.latestUsdeExactSpread.stale).toBe(true)
      expect(state.body?.latestUsdeExactSpread.ageSeconds).toBeGreaterThan(36 * 60 * 60)
      expect(state.body?.usdePilot.asOf).toBeNull()
      expect(state.body?.usdePilot.exactSpread).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a mis-keyed standalone rate and falls back to the newest valid one', () => {
    const bad = row('spread', 28, 26087000, hash('b'))
    const good = row('spread', 27, 26080000, hash('a'))
    expect(
      selectLatestUsdeExactSpread([
        { ...bad, data: { ...bad.data, currentBlockNumber: '26086999' } },
        good,
      ])?.block,
    ).toBe(26080000)
    expect(
      selectLatestUsdeExactSpread([
        { ...bad, data: { ...bad.data, currentBlockHash: 'not-a-block-hash' } },
        good,
      ])?.block,
    ).toBe(26080000)
    expect(
      selectLatestUsdeExactSpread([
        { ...bad, data: { ...bad.data, currentBlockTimestamp: time(27) } },
        good,
      ])?.block,
    ).toBe(26080000)
  })

  it('rejects corrupt stored USDe rate inputs and falls back in both projections', () => {
    const newest = complete(28, 26087000, hash('b'))
    const prior = complete(27, 26080000, hash('a'))
    const spread = newest[2].data as Record<string, any>
    const corruptions = [
      { schemaVersion: 2 },
      { leg: { ...spread.leg, borrowAsset: ghoLeg.borrowAsset } },
      { variableDebtToken: '0x0000000000000000000000000000000000000000' },
      { variableDebtToken: 'not-an-address' },
      { measurement: 'different_leg' },
      { claim: 'realized_wallet_return' },
      { rateConvention: 'nominal APR' },
      { priorBlockNumber: String(newest[2].block) },
      { priorBlockHash: 'bad' },
      { priorBlockTimestamp: time(20) },
      { lookbackSeconds: 604801 },
      { collectionStartedAt: 'invalid' },
      { capturedAt: 'invalid' },
      { collectionElapsedMs: 1285 },
      { collectionElapsedMs: -1 },
      { ageSecondsAtCapture: 900 },
      { capturedAt: new Date(Date.parse(time(28)) + 2 * 60 * 60 * 1000 + 1).toISOString() },
      { collectionStartedAt: new Date(Date.parse(time(28)) + 902_000).toISOString() },
      { currentVariableBorrowRateRayRaw: '64223049050947805975539927' },
      { currentVariableBorrowRateRayRaw: '0'.repeat(100000) },
      { shareUnitRaw: '1' },
      { currentAssetsPerShareUnitRaw: '1260200054285871351' },
      { priorAssetsPerShareUnitRaw: '1239075441898321131' },
      { currentAssetsPerShareUnitRaw: '0' },
      { assetDecimals: 6 },
      { shareDecimals: 6 },
      { borrowApy: measuredBorrowApy + 0.0001 },
      { yieldApy: measuredYieldApy + 0.0001 },
      { spread: measuredSpread + 0.0001 },
      { artifactSha256: 'bad' },
      { manifestSha256: 'bad' },
    ]
    for (const corruption of corruptions) {
      const bad = { ...newest[2], data: { ...spread, ...corruption } }
      expect(selectLatestUsdeExactSpread([bad, prior[2]])?.block, JSON.stringify(corruption)).toBe(
        26080000,
      )
      expect(
        selectUsdePilotPair([newest[0], newest[1], bad, ...prior]).asOf?.block,
        JSON.stringify(corruption),
      ).toBe(26080000)
    }
  })

  it('does not manufacture a pair when one current row differs in hash or time', () => {
    const rows = complete(27, 26080000)
    rows[1] = { ...rows[1], data: { ...rows[1].data, blockHash: hash('b') } }
    expect(selectUsdePilotPair(rows).asOf).toBeNull()
    rows[1] = { ...rows[1], data: { ...rows[1].data, blockHash: hash('a') }, observed_at: time(28) }
    expect(selectUsdePilotPair(rows).asOf).toBeNull()
  })

  it('rejects a mismatched spread hash or embedded head despite matching DB columns', () => {
    const rows = complete(27, 26080000)
    rows[2] = { ...rows[2], data: { ...rows[2].data, currentBlockHash: hash('b') } }
    expect(selectUsdePilotPair(rows).asOf).toBeNull()
    rows[2] = {
      ...rows[2],
      data: { ...rows[2].data, currentBlockHash: hash('a'), currentBlockNumber: '26080001' },
    }
    expect(selectUsdePilotPair(rows).asOf).toBeNull()
  })

  it('rejects mismatched capital/destination artifact identities at the same head', () => {
    const rows = complete(27, 26080000)
    rows[1] = { ...rows[1], data: { ...rows[1].data, artifactSha256: 'different' } }
    expect(selectUsdePilotPair(rows).asOf).toBeNull()
  })

  it('rejects mis-keyed capital and destination payloads even when DB columns match', () => {
    const rows = complete(27, 26080000)
    rows[0] = { ...rows[0], data: { ...rows[0].data, blockNumber: '26079999' } }
    expect(selectUsdePilotPair(rows).asOf).toBeNull()
    rows[0] = row('matched_capital', 27, 26080000, hash('a'))
    rows[1] = { ...rows[1], data: { ...rows[1].data, blockTimestamp: time(28) } }
    expect(selectUsdePilotPair(rows).asOf).toBeNull()
  })

  it('uses the prior complete trio when the newer stored capital payload is mis-keyed', () => {
    const newer = complete(28, 26087000, hash('b'))
    newer[0] = { ...newer[0], data: { ...newer[0].data, blockNumber: '26080000' } }
    const selected = selectUsdePilotPair([...newer, ...complete(27, 26080000)])
    expect(selected.asOf?.block).toBe(26080000)
    expect(selected.exactSpread?.block).toBe(26080000)
  })

  it('promotes the newer complete reading without carrying forward an older leg', () => {
    const selected = selectUsdePilotPair([
      ...complete(27, 26080000),
      ...complete(28, 26087000, hash('b')),
    ])
    expect(selected.asOf?.block).toBe(26087000)
    expect(selected.matchedCapital?.block).toBe(26087000)
    expect(selected.destinationVaultTvl?.block).toBe(26087000)
    expect(selected.exactSpread?.block).toBe(26087000)
  })
})

describe('GHO daily exact spread integrity', () => {
  beforeEach(() => {
    vi.mocked(db.execute).mockReset()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('keeps the newest valid stored reading even when stale', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z'))
    try {
      vi.mocked(db.execute).mockResolvedValue({ rows: [ghoSpreadRow(28, 26087000)] } as never)
      const { state, res } = response()
      await handler({ method: 'GET' } as never, res as never)
      expect(state.body?.exactAaveSpread).toEqual(
        expect.objectContaining({ block: 26087000, spread: 0.02, stale: true }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back from a malformed newest row to the prior valid one', () => {
    const prior = ghoSpreadRow(27, 26080000)
    const newest = ghoSpreadRow(28, 26087000, hash('b'))
    const corruptions = [
      { status: 'unavailable' },
      { key: spreadKey },
      { leg: { ...ghoLeg, destination: '0x0000000000000000000000000000000000000000' } },
      { blockNumber: '26086999' },
      { blockHash: 'not-a-hash' },
      { asOf: newest.data.asOf - 1 },
      { borrowApy: Number.NaN },
      { yieldApy: Number.POSITIVE_INFINITY },
      { spread: 0.03 },
      { rateConvention: 'APR, decimal fraction' },
      { borrowSource: 'different rate source' },
      { yieldSource: 'different yield source' },
      { lookback: { ...newest.data.lookback, seconds: 24 * 60 * 60 } },
      { lookback: { ...newest.data.lookback, priorAt: newest.data.lookback.priorAt - 1 } },
      { lookback: { ...newest.data.lookback, priorBlockNumber: String(newest.block) } },
    ]
    for (const corruption of corruptions) {
      expect(
        selectLatestGhoExactSpread([{ ...newest, data: { ...newest.data, ...corruption } }, prior])
          ?.block,
      ).toBe(26080000)
    }
    expect(selectLatestGhoExactSpread([newest, prior])?.block).toBe(26087000)
  })

  it('serves the prior GHO rate when the latest DB payload fails its saved-block check', async () => {
    const newest = ghoSpreadRow(28, 26087000, hash('b'))
    vi.mocked(db.execute).mockResolvedValue({
      rows: [
        { ...newest, data: { ...newest.data, blockNumber: '26086999' } },
        ghoSpreadRow(27, 26080000),
      ],
    } as never)
    const { state, res } = response()
    await handler({ method: 'GET' } as never, res as never)
    expect(state.status).toBe(200)
    expect(state.body?.exactAaveSpread?.block).toBe(26080000)
  })

  it('rejects a future exact rate and legacy displayed rows while retaining earlier readings', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-28T12:00:00Z'))
    try {
      const ghoKey = 'GHO → sGho [GHO]'
      const legacyRows = (day: number, block: number) =>
        (['holder_stock', 'destination_tvl', 'prospective_overlap'] as const).map((kind) => ({
          route_key: ghoKey,
          kind,
          block,
          observed_at: time(day),
          data: { measurement: kind },
        }))
      vi.mocked(db.execute).mockResolvedValue({
        rows: [
          ghoSpreadRow(28, 26087000, hash('b')),
          ...legacyRows(28, 26087000),
          ghoSpreadRow(27, 26080000),
          ...legacyRows(27, 26080000),
        ],
      } as never)
      const { state, res } = response()
      await handler({ method: 'GET' } as never, res as never)
      expect(state.status).toBe(200)
      expect(state.body?.exactAaveSpread?.block).toBe(26080000)
      expect(state.body?.holderStock?.block).toBe(26080000)
      expect(state.body?.destinationVaultTvl?.block).toBe(26080000)
      expect(state.body?.prospectiveOverlap?.block).toBe(26080000)
      expect(selectLatestGhoExactSpread([ghoSpreadRow(28, 26087000)])).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not accept another route key or a malformed DB timestamp', () => {
    const valid = ghoSpreadRow(27, 26080000)
    const wrongRoute = { ...ghoSpreadRow(28, 26087000), route_key: spreadKey }
    const wrongTime = { ...ghoSpreadRow(28, 26087000), observed_at: time(27) }
    expect(selectLatestGhoExactSpread([wrongRoute, wrongTime, valid])?.block).toBe(26080000)
  })

  it('projects only allowlisted public GHO fields, including nested leg and lookback', async () => {
    const saved = ghoSpreadRow(28, 26087000)
    vi.mocked(db.execute).mockResolvedValue({
      rows: [
        {
          ...saved,
          data: {
            ...saved.data,
            debugCredential: 'never public',
            leg: { ...saved.data.leg, privateLegNote: 'never public' },
            lookback: { ...saved.data.lookback, privateArchiveNote: 'never public' },
          },
        },
      ],
    } as never)
    const { state, res } = response()
    await handler({ method: 'GET' } as never, res as never)
    const reading = state.body?.exactAaveSpread
    expect(reading?.block).toBe(26087000)
    expect(reading?.debugCredential).toBeUndefined()
    expect(reading?.leg?.privateLegNote).toBeUndefined()
    expect(reading?.lookback?.privateArchiveNote).toBeUndefined()
    expect(reading?.leg).toEqual(ghoLeg)
    expect(reading?.lookback?.seconds).toBe(7 * 24 * 60 * 60)
  })
})

describe('GHO fixed-20 matched-capital integrity', () => {
  it('retains zero and stale readings but falls back past a bad latest aggregate', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-02T12:00:00Z'))
    try {
      const prior = ghoCapitalRow(27, 26080000)
      prior.data.matchedRaw = '0'
      prior.data.matchedGho = 0
      const newest = ghoCapitalRow(28, 26087000, hash('b'))
      const corruptions = [
        { sourceSha256: 'f'.repeat(64) },
        { borrowAsset: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3' },
        { receiptProofCount: 19 },
        { observedWalletCount: 19 },
        { completeWalletCount: 19 },
        { unknownWalletCount: 1 },
        { matchedRaw: '12600000000000000000' },
        { matchedGho: 12.6 },
        { blockHash: 'invalid' },
      ]
      for (const corruption of corruptions) {
        expect(
          selectLatestGhoMatchedCapital([
            { ...newest, data: { ...newest.data, ...corruption } },
            prior,
          ])?.block,
        ).toBe(26080000)
      }
      vi.mocked(db.execute).mockResolvedValue({ rows: [newest, prior] } as never)
      const { state, res } = response()
      await handler({ method: 'GET' } as never, res as never)
      expect(state.body?.matchedCapital).toEqual(
        expect.objectContaining({ block: 26087000, matchedGho: 12.5, stale: true }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a future-dated row and retains the prior fixed-20 reading', () => {
    const prior = ghoCapitalRow(27, 26080000)
    const future = ghoCapitalRow(28, 26087000, hash('b'))
    const beforeFuture = Date.parse(time(28)) - 1
    expect(selectLatestGhoMatchedCapital([future, prior], beforeFuture)?.block).toBe(26080000)
    expect(selectLatestGhoMatchedCapital([future], beforeFuture)).toBeNull()
  })
})
