import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { appendLocalVenueSnapshot } from './localVenueSnapshotStore.mjs'
import {
  localObservationIsNewer,
  localOnlyVenueSummary,
  readLocalVenueSummary,
} from './venueSummaryLocal.mjs'

const SOURCE = Date.parse('2026-10-04T11:00:00.000Z') / 1_000
const FETCHED = '2026-10-04T11:01:00.000Z'
const RECEIPT = '2026-10-04T11:02:00.000Z'
const NOW = Date.parse('2026-10-04T12:00:00.000Z')
const HASH = `0x${'a'.repeat(64)}`
const ampleDisk = () => ({ bavail: 2_000_000_000, bsize: 4096 })
const cfg = { name: 'sUSDe', kind: 'erc4626-cooldown', enabled: true }

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'venue-summary-local-'))
  try {
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function append(
  root,
  {
    venue = 'sUSDe',
    kind = cfg.kind,
    extraParams = {},
    instantUsd = null,
    block = '26100000',
    hash = HASH,
    timestamp = SOURCE,
    observedAtUtc = FETCHED,
    receiptAt = RECEIPT,
  } = {},
) {
  return appendLocalVenueSnapshot(
    {
      venue,
      chain: 'ethereum',
      source: { block, hash, timestamp, finalized: true, pinned: true },
      observedAtUtc,
      instantUsd,
      coolingUsd: null,
      strandedUsd: null,
      params: {
        kind,
        totalAssets: '100000000000000000000',
        depth_usd: 10_000,
        depth_complete: true,
        read_block_finalized: true,
        read_block_pinned: true,
        read_block_number: block,
        read_block_hash: hash,
        read_block_time: timestamp,
        ...extraParams,
      },
    },
    { out: root, stat: ampleDisk, now: () => new Date(receiptAt) },
  ).record
}

test('verified local reading preserves source, fetch, and first receipt times', () =>
  withRoot((root) => {
    append(root)
    const local = readLocalVenueSummary('sUSDe', cfg, { root, nowMs: NOW })
    assert.equal(local.status, 'fresh')
    assert.equal(local.count, 1)
    assert.equal(local.observed.block, 26_100_000)
    assert.equal(local.observed.params.depthUsd, 10_000)
    assert.equal(local.hasInstant, true)
    assert.deepEqual(local.times, {
      sourceAt: '2026-10-04T11:00:00.000Z',
      fetchedAt: FETCHED,
      firstLocalReceiptAt: RECEIPT,
    })
    assert.equal(local.observed.observedAt, FETCHED)
    assert.equal(localObservationIsNewer(local, { block: 26_099_999 }), true)
    assert.equal(localObservationIsNewer(local, { block: 26_100_000 }), false)
  }))

test('local-only fallback leaves DB flow, news, and alarm coverage unknown', () =>
  withRoot((root) => {
    append(root)
    const local = readLocalVenueSummary('sUSDe', cfg, { root, nowMs: NOW + 4 * 60 * 60 * 1_000 })
    assert.equal(local.status, 'stale')
    const summary = localOnlyVenueSummary('sUSDe', 'sUSDe', cfg, local)
    assert.equal(summary.provenance.observationStatus, 'stale')
    assert.equal(summary.provenance.databaseStatus, 'unavailable')
    assert.equal(summary.corpus.snapshotsObserved, 1)
    assert.equal(summary.corpus.flows, null)
    assert.equal(summary.corpus.news, null)
    assert.equal(summary.alarms.status, 'unknown')
    assert.deepEqual(summary.alarms.open, [])
    assert.equal(summary.worstOutflows.d1, null)
    assert.equal(summary.worstOutflows.d7, null)
  }))

test('missing, future, corrupted, or wrong-identity local records never become current observations', () =>
  withRoot((root) => {
    assert.equal(readLocalVenueSummary('sUSDe', cfg, { root, nowMs: NOW }).status, 'missing')
    append(root)
    assert.equal(
      readLocalVenueSummary('sUSDe', cfg, { root, nowMs: NOW - 2 * 60 * 60 * 1_000 }).status,
      'unknown',
    )
    assert.throws(
      () =>
        readLocalVenueSummary('sUSDe', { ...cfg, kind: 'atoken-liquidity' }, { root, nowMs: NOW }),
      /local_summary_identity_mismatch/,
    )
    const path = join(root, 'sUSDe', '000000000001.json')
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('100000000000000000000', '200000000000000000000'),
    )
    assert.throws(() => readLocalVenueSummary('sUSDe', cfg, { root, nowMs: NOW }), /sha_mismatch/)
  }))

test('Aave supplied stock requires configured identity and an actual supply read', () =>
  withRoot((root) => {
    const aave = {
      name: 'aave-v3-usde',
      kind: 'atoken-liquidity',
      address: '0x1111111111111111111111111111111111111111',
      underlying: '0x2222222222222222222222222222222222222222',
      decimals: 18,
    }
    append(root, {
      venue: aave.name,
      kind: aave.kind,
      instantUsd: 50,
      extraParams: {
        aToken: aave.address,
        underlying: aave.underlying,
        decimals: 18,
        totalSupply: '125000000000000000000',
        reads: { totalSupply: true },
        underlyingIdentity: 'match',
        decimalsIdentity: 'match',
        priceAssumptionUsd: 1,
      },
    })
    const local = readLocalVenueSummary(aave.name, aave, { root, nowMs: NOW })
    assert.deepEqual(local.suppliedTvl, {
      usd: 125,
      block: 26_100_000,
      observedAt: FETCHED,
    })
    assert.throws(
      () =>
        readLocalVenueSummary(
          aave.name,
          { ...aave, address: '0x3333333333333333333333333333333333333333' },
          { root, nowMs: NOW },
        ),
      /local_summary_identity_mismatch/,
    )
  }))

test('Aave supplied stock uses the latest prior verified supply when the newest cash row lacks a supply read', () =>
  withRoot((root) => {
    const aave = {
      name: 'aave-v3-usde',
      kind: 'atoken-liquidity',
      address: '0x1111111111111111111111111111111111111111',
      underlying: '0x2222222222222222222222222222222222222222',
      decimals: 18,
    }
    const identity = {
      aToken: aave.address,
      underlying: aave.underlying,
      decimals: 18,
      underlyingIdentity: 'match',
      decimalsIdentity: 'match',
      priceAssumptionUsd: 1,
    }
    append(root, {
      venue: aave.name,
      kind: aave.kind,
      instantUsd: 60,
      extraParams: {
        ...identity,
        totalSupply: '100000000000000000000',
        reads: { totalSupply: true },
      },
    })
    append(root, {
      venue: aave.name,
      kind: aave.kind,
      block: '26100001',
      hash: `0x${'b'.repeat(64)}`,
      timestamp: SOURCE + 60,
      observedAtUtc: '2026-10-04T11:03:00.000Z',
      receiptAt: '2026-10-04T11:04:00.000Z',
      instantUsd: 55,
      extraParams: {
        ...identity,
        totalSupply: '125000000000000000000',
        reads: { totalSupply: true },
      },
    })
    append(root, {
      venue: aave.name,
      kind: aave.kind,
      block: '26100002',
      hash: `0x${'c'.repeat(64)}`,
      timestamp: SOURCE + 120,
      observedAtUtc: '2026-10-04T11:05:00.000Z',
      receiptAt: '2026-10-04T11:06:00.000Z',
      instantUsd: 42,
      extraParams: { ...identity, totalSupply: null, reads: { totalSupply: false } },
    })

    const local = readLocalVenueSummary(aave.name, aave, { root, nowMs: NOW })
    assert.equal(local.count, 3)
    assert.equal(local.observed.block, 26_100_002)
    assert.equal(local.observed.instantUsd, 42)
    assert.deepEqual(local.times, {
      sourceAt: '2026-10-04T11:02:00.000Z',
      fetchedAt: '2026-10-04T11:05:00.000Z',
      firstLocalReceiptAt: '2026-10-04T11:06:00.000Z',
    })
    assert.deepEqual(local.suppliedTvl, {
      usd: 125,
      block: 26_100_001,
      observedAt: '2026-10-04T11:03:00.000Z',
    })
  }))
