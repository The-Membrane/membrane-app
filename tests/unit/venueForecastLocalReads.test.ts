import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { db } from '@/db'
import { readVenueForecastEvidence } from '@/pages/api/_lib/venueForecastReads'
import { localVenueFlowStore } from '@/scripts/lib/localVenueFlowStore.mjs'
import {
  acquireLocalVenueSnapshotWriter,
  appendLocalVenueSnapshot,
  markLocalVenueSnapshotAttempt,
} from '@/scripts/lib/localVenueSnapshotStore.mjs'
import { makeReceipt, requiredStreamIdentities, streamsFor } from '@/scripts/record-venue-flows.mjs'
import recorderConfig from '@/tools/venue-recorder.config.json'

vi.mock('@/db', () => ({ db: { execute: vi.fn() } }))

const observedAt = '2026-09-30T21:26:48.259Z'
const blockTime = Math.floor(Date.parse(observedAt) / 1000) - 10
const hash = `0x${'a'.repeat(64)}`
const cases = [
  { venue: 'sUSDe', metric: 'depth_usd', capacity: 101 },
  { venue: 'aave-v3-usde', metric: 'instant_usd', capacity: 102 },
  { venue: 'sGHO', metric: 'instant_usd', capacity: 103 },
  { venue: 'sUSDS', metric: 'depth_usd', capacity: 104 },
  { venue: 'scrvUSD', metric: 'depth_usd', capacity: 105 },
] as const

describe('local Mac venue forecast evidence', () => {
  let root: string
  let snapshotRoot: string
  let flowRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'membrane-local-forecast-'))
    snapshotRoot = join(root, 'snapshots')
    flowRoot = join(root, 'flows')
    vi.mocked(db.execute).mockReset()
    vi.mocked(db.execute).mockRejectedValue(
      Object.assign(new Error('database unavailable'), { name: 'NeonDbError' }),
    )
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function markAttempt(input: Parameters<typeof markLocalVenueSnapshotAttempt>[0], _out?: string) {
    const token = acquireLocalVenueSnapshotWriter(input.identity, snapshotRoot)
    markLocalVenueSnapshotAttempt({ ...input, token }, snapshotRoot)
  }

  function seal(
    venue: string,
    capacity: number,
    chain = 'ethereum',
    paramsOverride: Record<string, unknown> = {},
  ) {
    const configured = recorderConfig.venues.find((entry) => entry.name === venue)!
    const depthMarkets = configured.depthMarkets
      ?.filter((market) => market.enabled)
      .map((market) =>
        market.kind === 'psm-buffer'
          ? {
              ...market,
              pocketIdentity: 'match',
              gemIdentity: 'match',
              exitIdentity: 'match',
              pocketOnchain: market.buffer,
              gemOnchain: market.bufferToken,
              wrapperIdentity: 'match',
              wrapperPsmOnchain: market.address,
              wrapperPocketOnchain: market.buffer,
              wrapperUsdsOnchain: configured.underlying,
              toutRaw: '0',
              buyGemState: 'open',
              exitableUsd: capacity,
            }
          : market.kind === 'curve-stableswap'
            ? {
                ...market,
                coinsIdentity: 'match',
                coin0Onchain: market.token0,
                coin1Onchain: market.token1,
              }
            : market,
      )
    appendLocalVenueSnapshot(
      {
        venue,
        chain,
        source: { block: '26092897', hash, timestamp: blockTime, finalized: true, pinned: true },
        observedAtUtc: observedAt,
        instantUsd: venue === 'aave-v3-usde' || venue === 'sGHO' ? capacity : null,
        coolingUsd: null,
        strandedUsd: null,
        params: {
          read_block_finalized: true,
          read_block_pinned: true,
          read_block_number: '26092897',
          read_block_hash: hash,
          read_block_time: blockTime,
          depth_usd: venue === 'aave-v3-usde' || venue === 'sGHO' ? null : capacity,
          depth_complete: true,
          depthMarkets,
          underlyingIdentity: 'match',
          decimalsIdentity: 'match',
          withdrawalsPaused: false,
          kind: configured.kind,
          aToken: configured.address,
          vault: configured.address,
          underlyingOnchain: configured.underlying,
          underlyingDecimalsOnchain: configured.decimals,
          reads: { underlyingBalance: true },
          ...paramsOverride,
        },
      },
      { out: snapshotRoot, now: () => new Date(observedAt) },
    )
  }

  it.each(cases)(
    'serves verified $venue point measurements without claiming flow history',
    async ({ venue, metric, capacity }) => {
      seal(venue, capacity)
      const evidence = await readVenueForecastEvidence(venue, {
        allowLocalFallback: true,
        localSnapshotRoot: snapshotRoot,
        localFlowRoot: flowRoot,
      })
      expect(evidence.storage).toBe('local_mac_recorder')
      expect(evidence.route.metric).toBe(metric)
      expect(evidence.latest).toMatchObject({
        source: 'observed',
        block: 26092897,
        observedAt: new Date(blockTime * 1000).toISOString(),
        capacityUsd: capacity,
        coverage: 'complete',
        firstAvailableAt: observedAt,
      })
      expect(evidence.latest?.sourceId).toMatch(/^local:[0-9a-f]{64}$/)
      expect(evidence.coverage).toMatchObject({
        observedRows: 1,
        returnedRows: 1,
        flowStatus: 'uncertified',
        flowReason: 'local_flow_no_sealed_ranges',
        maxGrossOutflowUsd: null,
        maxNetOutflowUsd: null,
        exitDurationDistribution: null,
      })
      expect(db.execute).not.toHaveBeenCalled()
    },
  )

  it('requires explicit fallback permission and keeps short sealed flow partial', async () => {
    seal('sUSDe', 101)
    await expect(readVenueForecastEvidence('sUSDe')).rejects.toMatchObject({ name: 'NeonDbError' })
    const streams = streamsFor({
      name: 'sUSDe',
      kind: 'erc4626-cooldown',
      address: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497',
    })
    if (!streams) throw new Error('expected sUSDe flow streams')
    const receipt = makeReceipt({
      venue: 'sUSDe',
      from: 26092898n,
      to: 26092929n,
      fromHash: `0x${'b'.repeat(64)}`,
      toHash: `0x${'c'.repeat(64)}`,
      finalized: { number: 26092929n, hash: `0x${'c'.repeat(64)}` },
      identities: requiredStreamIdentities(streams),
      counts: streams.map(() => 0),
      rows: [],
    })
    await localVenueFlowStore({ out: flowRoot }).insertReceipt(receipt, [])
    const evidence = await readVenueForecastEvidence('sUSDe', {
      allowLocalFallback: true,
      localSnapshotRoot: snapshotRoot,
      localFlowRoot: flowRoot,
    })
    expect(evidence.coverage).toMatchObject({
      flowStatus: 'sealed_partial',
      sealedRanges: 1,
      sealedEvents: 0,
      maxGrossOutflowUsd: null,
      maxNetOutflowUsd: null,
      exitDurationDistribution: null,
    })
  })

  it('rejects a changed local measurement rather than returning a false decline', async () => {
    seal('sUSDe', 101)
    const path = join(snapshotRoot, 'sUSDe', '000000000001.json')
    writeFileSync(path, readFileSync(path, 'utf8').replace('"depthUsd":101', '"depthUsd":1'))
    await expect(
      readVenueForecastEvidence('sUSDe', {
        allowLocalFallback: true,
        localSnapshotRoot: snapshotRoot,
        localFlowRoot: flowRoot,
      }),
    ).rejects.toThrow('local_snapshot_sha_mismatch')
  })

  it('keeps historical successes but withholds latest cash after a newer failed capture', async () => {
    seal('aave-v3-usde', 102)
    const venue = recorderConfig.venues.find((entry) => entry.name === 'aave-v3-usde')!
    markAttempt(
      {
        identity: {
          venue: venue.name,
          chain: 'ethereum',
          kind: venue.kind,
          address: venue.address,
          underlying: venue.underlying,
          decimals: venue.decimals,
        },
        attemptedAtUtc: '2026-10-01T12:00:00.000Z',
        status: 'capture_failed',
      },
      snapshotRoot,
    )
    const evidence = await readVenueForecastEvidence('aave-v3-usde', {
      allowLocalFallback: true,
      localSnapshotRoot: snapshotRoot,
      localFlowRoot: flowRoot,
    })
    expect(evidence.latest).toBeNull()
    expect(evidence.samples).toHaveLength(1)
    expect(evidence.samples[0].capacityUsd).toBe(102)
    expect(evidence.coverage.latestAttempt).toEqual({
      status: 'capture_failed',
      attemptedAtUtc: '2026-10-01T12:00:00.000Z',
      token: expect.any(String),
    })
  })

  it('keeps a newer pending attempt active even when an older success has a later receipt clock', async () => {
    seal('aave-v3-usde', 102)
    const venue = recorderConfig.venues.find((entry) => entry.name === 'aave-v3-usde')!
    markAttempt(
      {
        identity: {
          venue: venue.name,
          chain: 'ethereum',
          kind: venue.kind,
          address: venue.address,
          underlying: venue.underlying,
          decimals: venue.decimals,
        },
        attemptedAtUtc: '2026-10-01T12:01:00.000Z',
        status: 'capture_in_progress',
      },
      snapshotRoot,
    )
    const evidence = await readVenueForecastEvidence('aave-v3-usde', {
      allowLocalFallback: true,
      localSnapshotRoot: snapshotRoot,
      localFlowRoot: flowRoot,
    })
    expect(evidence.latest).toBeNull()
    expect(evidence.coverage.latestAttempt?.status).toBe('capture_in_progress')
  })

  it('fails closed on a corrupt latest-attempt marker', async () => {
    seal('aave-v3-usde', 102)
    const venue = recorderConfig.venues.find((entry) => entry.name === 'aave-v3-usde')!
    markAttempt(
      {
        identity: {
          venue: venue.name,
          chain: 'ethereum',
          kind: venue.kind,
          address: venue.address,
          underlying: venue.underlying,
          decimals: venue.decimals,
        },
        attemptedAtUtc: '2026-10-01T12:00:00.000Z',
        status: 'capture_failed',
      },
      snapshotRoot,
    )
    writeFileSync(join(snapshotRoot, venue.name, 'latest-attempt'), '{}\n')
    await expect(
      readVenueForecastEvidence('aave-v3-usde', {
        allowLocalFallback: true,
        localSnapshotRoot: snapshotRoot,
        localFlowRoot: flowRoot,
      }),
    ).rejects.toThrow('local_snapshot_attempt_sha_mismatch')
  })

  it('does not fall back to database cash after a local failure with no successful local sample', async () => {
    const venue = recorderConfig.venues.find((entry) => entry.name === 'aave-v3-usde')!
    markAttempt(
      {
        identity: {
          venue: venue.name,
          chain: 'ethereum',
          kind: venue.kind,
          address: venue.address,
          underlying: venue.underlying,
          decimals: venue.decimals,
        },
        attemptedAtUtc: '2026-10-01T12:00:00.000Z',
        status: 'capture_failed',
      },
      snapshotRoot,
    )
    await expect(
      readVenueForecastEvidence('aave-v3-usde', {
        allowLocalFallback: true,
        localSnapshotRoot: snapshotRoot,
        localFlowRoot: flowRoot,
      }),
    ).rejects.toThrow('local_forecast_capture_without_history')
    expect(db.execute).not.toHaveBeenCalled()
  })

  it('does not promote a locally sealed record from another chain to Ethereum', async () => {
    seal('sGHO', 103, 'arbitrum')
    await expect(
      readVenueForecastEvidence('sGHO', {
        allowLocalFallback: true,
        localSnapshotRoot: snapshotRoot,
        localFlowRoot: flowRoot,
      }),
    ).rejects.toThrow('local_forecast_source_identity_mismatch')
  })

  it('does not train on a changed depth market set or mismatched Aave asset', async () => {
    seal('sUSDe', 101, 'ethereum', { depthMarkets: [] })
    seal('aave-v3-usde', 102, 'ethereum', { underlyingIdentity: 'mismatch' })
    for (const name of ['sUSDe', 'aave-v3-usde']) {
      const evidence = await readVenueForecastEvidence(name, {
        allowLocalFallback: true,
        localSnapshotRoot: snapshotRoot,
        localFlowRoot: flowRoot,
      })
      expect(evidence.latest).toMatchObject({ capacityUsd: null, coverage: 'partial' })
    }
  })

  it('uses a verified local snapshot before querying a stale or malformed database row', async () => {
    seal('sUSDe', 101)
    const execute = vi.mocked(db.execute)
    execute.mockReset()
    const evidence = await readVenueForecastEvidence('sUSDe', {
      allowLocalFallback: true,
      localSnapshotRoot: snapshotRoot,
      localFlowRoot: flowRoot,
    })
    expect(evidence.storage).toBe('local_mac_recorder')
    expect(evidence.latest?.block).toBe(26092897)
    expect(execute).not.toHaveBeenCalled()
  })

  it('falls through to the database only when the local snapshot store is absent', async () => {
    await expect(
      readVenueForecastEvidence('sUSDe', {
        allowLocalFallback: true,
        localSnapshotRoot: snapshotRoot,
        localFlowRoot: flowRoot,
      }),
    ).rejects.toMatchObject({ name: 'NeonDbError' })
    expect(db.execute).toHaveBeenCalledTimes(1)
  })
})
