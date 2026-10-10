import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import * as historicalCashContextModule from '../../lib/carry/historicalCashContext.ts'
import {
  appendLocalSupplementalAaveUsdeCash,
  buildSupplementalAaveUsdeCashManifest,
  localSupplementalAaveUsdeCashObservationsFromVerified,
  readLocalSupplementalAaveUsdeCashObservations,
  supplementalAaveUsdeDirectMarket,
  verifyLocalSupplementalAaveUsdeCash,
} from './localSupplementalAaveUsdeCashStore.mjs'
import {
  historicalAnchorGrid,
  parseOptions,
  run,
} from '../record-supplemental-aave-usde-cash-local.mjs'

const SUBJECT = {
  market_key: 'aaveV3Usde',
  route_key: 'USDe → supply on Aave V3',
  destination: '0x4f5923fc5fd4a93352581b38b7cd26943012decf',
  asset: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
  asset_decimals: 18,
  venue_kind: 'aave_v3_atoken',
  source_kind: 'market',
  cohort_id: 'supplemental-aave-v3-usde-2026-09',
}
const DIRECT = {
  routeKey: SUBJECT.route_key,
  destination: '0x4F5923Fc5FD4a93352581b38B7cD26943012DECF',
  underlying: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3',
  decimals: 18,
}
const historicalCarryCashContext =
  historicalCashContextModule.historicalCarryCashContext ??
  historicalCashContextModule.default?.historicalCarryCashContext
const at = '2026-10-05T11:59:00.000Z'
const block = {
  number: 27_000_001n,
  hash: `0x${'a'.repeat(64)}`,
  timestamp: BigInt(Date.parse(at) / 1000),
  at,
}

function sandbox() {
  const parent = mkdtempSync(join(tmpdir(), 'supplemental-aave-usde-cash-'))
  return { parent, root: join(parent, 'ledger') }
}

function removeSandbox(parent) {
  rmSync(parent, { recursive: true, force: true })
}

async function fixtureManifest() {
  return buildSupplementalAaveUsdeCashManifest({
    issueManifest: { supplementalSubjects: [{ ...SUBJECT }] },
    directMarket: { ...DIRECT },
  })
}

function observedRow(manifest, anchorAt = at, source = block, cashRaw = '12345') {
  return {
    captureKind: 'backfilled',
    routeKey: SUBJECT.route_key,
    marketKey: SUBJECT.market_key,
    sourceKind: 'market',
    subjectKind: 'direct',
    venueKind: SUBJECT.venue_kind,
    destination: SUBJECT.destination,
    anchorAt,
    chainId: 1,
    block: source.number.toString(),
    blockHash: source.hash,
    blockAt: source.at,
    asset: SUBJECT.asset,
    shareDecimals: 18,
    assetDecimals: 18,
    cashRaw,
    state: 'observed',
    reason: null,
    cohortId: SUBJECT.cohort_id,
    subjectManifestSha256: manifest.sha256,
  }
}

test('manifest binds the only supplemental subject to the direct market constant', async () => {
  const manifest = await buildSupplementalAaveUsdeCashManifest()
  assert.deepEqual(manifest.subjects, [SUBJECT])
  assert.match(manifest.sha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(supplementalAaveUsdeDirectMarket(manifest), {
    routeKey: SUBJECT.route_key,
    destination: SUBJECT.destination,
    underlying: SUBJECT.asset,
    decimals: 18,
    venueKind: 'aave_v3_atoken',
    identityFn: 'UNDERLYING_ASSET_ADDRESS',
  })
  await assert.rejects(
    buildSupplementalAaveUsdeCashManifest({
      issueManifest: { supplementalSubjects: [{ ...SUBJECT }, { ...SUBJECT }] },
      directMarket: DIRECT,
    }),
    /subject_count/,
  )
  await assert.rejects(
    buildSupplementalAaveUsdeCashManifest({
      issueManifest: { supplementalSubjects: [{ ...SUBJECT, asset_decimals: 6 }] },
      directMarket: DIRECT,
    }),
    /subject_identity/,
  )
  await assert.rejects(
    buildSupplementalAaveUsdeCashManifest({
      issueManifest: { supplementalSubjects: [{ ...SUBJECT }] },
      directMarket: { ...DIRECT, underlying: `0x${'b'.repeat(40)}` },
    }),
    /market_identity/,
  )
})

test('separate receipts are canonical, SHA-chained and expose the historical reader seam', async () => {
  const manifest = await fixtureManifest()
  const { parent, root } = sandbox()
  try {
    const input = {
      collectionMode: 'current',
      anchorAt: at,
      block,
      rows: [observedRow(manifest)],
      firstLocalReceiptAt: '2026-10-05T12:00:00.000Z',
    }
    const current = appendLocalSupplementalAaveUsdeCash(input, manifest, root)
    assert.equal(current.status, 'recorded')
    assert.equal(
      appendLocalSupplementalAaveUsdeCash(input, manifest, root).status,
      'already_recorded',
    )
    const history = appendLocalSupplementalAaveUsdeCash(
      {
        ...input,
        collectionMode: 'retrospective',
        firstLocalReceiptAt: '2026-10-05T12:01:00.000Z',
      },
      manifest,
      root,
    )
    assert.equal(history.record.previousSha256, current.record.sha256)
    const verified = verifyLocalSupplementalAaveUsdeCash(manifest, root)
    assert.equal(verified.count, 2)
    const observations = readLocalSupplementalAaveUsdeCashObservations(manifest, root)
    assert.deepEqual(localSupplementalAaveUsdeCashObservationsFromVerified(verified), observations)
    assert.equal(observations[0].evidenceKind, 'current_finalized_observation')
    assert.equal(observations[1].evidenceKind, 'retrospective_reconstruction')
    assert.equal(observations[0].subjects.length, 1)
    assert.equal(observations[0].subjects[0].collectionMode, 'current')
    assert.equal(observations[0].subjects[0].assetDecimals, 18)
    assert.ok(!('captureKind' in observations[0].subjects[0]))
    assert.deepEqual(
      historicalCarryCashContext(observations, {
        route_key: SUBJECT.route_key,
        destination: SUBJECT.destination,
        asset: SUBJECT.asset,
      }),
      {
        status: 'unavailable',
        reason: 'insufficient_daily_anchors',
        routeKey: SUBJECT.route_key,
        destination: SUBJECT.destination,
      },
    )
    const path = join(root, '000000000002.json')
    const changed = JSON.parse(readFileSync(path, 'utf8'))
    changed.rows[0].cashRaw = '9999'
    writeFileSync(path, `${JSON.stringify(changed)}\n`)
    assert.throws(() => verifyLocalSupplementalAaveUsdeCash(manifest, root), /hash_mismatch/)
  } finally {
    removeSandbox(parent)
  }
})

test('identity drift, unknown files and malformed verifier inputs fail closed', async () => {
  const manifest = await fixtureManifest()
  const { parent, root } = sandbox()
  try {
    const input = {
      collectionMode: 'current',
      anchorAt: at,
      block,
      rows: [{ ...observedRow(manifest), assetDecimals: 6 }],
      firstLocalReceiptAt: '2026-10-05T12:00:00.000Z',
    }
    assert.throws(() => appendLocalSupplementalAaveUsdeCash(input, manifest, root), /invalid_cash/)
    assert.equal(verifyLocalSupplementalAaveUsdeCash(manifest, root).count, 0)
    appendLocalSupplementalAaveUsdeCash({ ...input, rows: [observedRow(manifest)] }, manifest, root)
    writeFileSync(join(root, '.DS_Store'), 'unexpected')
    assert.throws(() => verifyLocalSupplementalAaveUsdeCash(manifest, root), /unexpected_entry/)
    assert.throws(
      () =>
        localSupplementalAaveUsdeCashObservationsFromVerified({
          count: 0,
          last: null,
          records: [],
        }),
      /verified_input/,
    )
  } finally {
    removeSandbox(parent)
  }
})

test('current mode uses readDirectCash identity checks and deduplicates a finalized block', async () => {
  const manifest = await fixtureManifest()
  const { parent, root } = sandbox()
  const calls = []
  const client = {
    getChainId: async () => 1,
    getBlock: async () => block,
    getCode: async ({ address, blockNumber }) => {
      calls.push(['code', address, blockNumber])
      return '0x6000'
    },
    readContract: async ({ address, functionName, args, blockNumber }) => {
      calls.push(['read', address, functionName, args, blockNumber])
      if (functionName === 'UNDERLYING_ASSET_ADDRESS') return SUBJECT.asset
      if (functionName === 'decimals') return 18
      if (functionName === 'balanceOf') return 12345n
      throw new Error('unexpected_call')
    },
  }
  try {
    const options = parseOptions(['--current'])
    const first = await run(client, manifest, options, root, {
      clock: () => Date.parse('2026-10-05T12:00:00.000Z'),
    })
    assert.equal(first.skipped, 0)
    assert.equal(first.count, 1)
    assert.deepEqual(first.captures[0].coverage, {
      observed: 1,
      no_code: 0,
      identity_mismatch: 0,
    })
    assert.ok(calls.some((entry) => entry[0] === 'read' && entry[2] === 'balanceOf'))
    const second = await run(client, manifest, options, root, {
      clock: () => Date.parse('2026-10-05T12:00:00.000Z'),
    })
    assert.equal(second.skipped, 1)
    assert.equal(second.count, 1)
    assert.equal(
      verifyLocalSupplementalAaveUsdeCash(manifest, root).records[0].rows[0].cashRaw,
      '12345',
    )
  } finally {
    removeSandbox(parent)
  }
})

test('transient reads never seal and read-only modes need no client', async () => {
  const manifest = await fixtureManifest()
  const { parent, root } = sandbox()
  const client = {
    getChainId: async () => 1,
    getBlock: async () => block,
  }
  try {
    await assert.rejects(
      run(client, manifest, parseOptions(['--current']), root, {
        clock: () => Date.parse('2026-10-05T12:00:00.000Z'),
        readCash: async () => ({
          state: 'read_unavailable',
          reason: 'archive_state_read_failed',
        }),
      }),
      /transient_subject_read/,
    )
    assert.equal(verifyLocalSupplementalAaveUsdeCash(manifest, root).count, 0)
    const verified = await run(null, manifest, parseOptions(['--verify']), root)
    const coverage = await run(null, manifest, parseOptions(['--coverage']), root)
    assert.equal(verified.count, 0)
    assert.equal(coverage.subjects.length, 1)
    assert.deepEqual(coverage.subjects[0].current, {
      observed: 0,
      no_code: 0,
      identity_mismatch: 0,
    })
  } finally {
    removeSandbox(parent)
  }
})

test('history mode is bounded and preserves retrospective anchor and receipt clocks', async () => {
  const manifest = await fixtureManifest()
  const { parent, root } = sandbox()
  const finalizedAt = '2026-10-05T12:00:00.000Z'
  const finalized = {
    number: 27_100_000n,
    hash: `0x${'f'.repeat(64)}`,
    timestamp: BigInt(Date.parse(finalizedAt) / 1000),
  }
  const blocks = new Map()
  let sequence = 0n
  const client = {
    getChainId: async () => 1,
    getBlock: async ({ blockTag, blockNumber }) => {
      if (blockTag === 'finalized') return finalized
      return blocks.get(blockNumber)
    },
  }
  const options = parseOptions([
    '--history',
    '--as-of',
    '2026-10-05T00:00:00.000Z',
    '--lookback-hours',
    '72',
    '--step-hours',
    '24',
    '--max-anchors',
    '2',
  ])
  try {
    assert.deepEqual(historicalAnchorGrid(finalizedAt, options), [
      '2026-10-02T00:00:00.000Z',
      '2026-10-03T00:00:00.000Z',
      '2026-10-04T00:00:00.000Z',
    ])
    const result = await run(client, manifest, options, root, {
      clock: () => Date.parse('2026-10-05T12:01:00.000Z'),
      resolveBlock: async (_, anchorAt) => {
        sequence += 1n
        const resolved = {
          number: 26_000_000n + sequence,
          hash: `0x${sequence.toString().padStart(64, '0')}`,
          timestamp: BigInt(Date.parse(anchorAt) / 1000),
        }
        blocks.set(resolved.number, resolved)
        return resolved
      },
      readCash: async () => ({
        state: 'observed',
        reason: null,
        asset: SUBJECT.asset,
        shareDecimals: 18,
        assetDecimals: 18,
        cashRaw: '50000',
      }),
    })
    assert.equal(result.captures.length, 2)
    assert.equal(result.remaining, 1)
    const records = verifyLocalSupplementalAaveUsdeCash(manifest, root).records
    assert.ok(records.every((record) => record.collectionMode === 'retrospective'))
    assert.deepEqual(
      records.map((record) => record.anchorAt),
      ['2026-10-02T00:00:00.000Z', '2026-10-03T00:00:00.000Z'],
    )
    assert.ok(records.every((record) => record.firstLocalReceiptAt === '2026-10-05T12:01:00.000Z'))
  } finally {
    removeSandbox(parent)
  }
})

test('CLI bounds reject unbounded or ambiguous collection', () => {
  assert.throws(() => parseOptions(['--history', '--lookback-hours', '2881']), /history_bounds/)
  assert.throws(() => parseOptions(['--current', '--history']), /multiple_modes/)
  assert.throws(() => parseOptions(['--current', '--lookback-hours', '24']), /history_options_only/)
  assert.equal(parseOptions(['--history', '--max-anchors', '4']).maxAnchors, 4)
  assert.throws(() => parseOptions(['--history', '--max-anchors', '5']), /history_bounds/)
})
