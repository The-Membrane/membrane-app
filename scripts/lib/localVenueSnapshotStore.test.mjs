import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  appendLocalVenueSnapshot,
  acquireLocalVenueSnapshotWriter,
  clearLocalVenueSnapshotAttempt,
  markLocalVenueSnapshotAttempt,
  MIN_LOCAL_SNAPSHOT_FREE_BYTES,
  readLocalVenueSnapshotAttempt,
  releaseLocalVenueSnapshotWriter,
  runDatabaseOrLocal,
  verifyLocalVenueSnapshots,
} from './localVenueSnapshotStore.mjs'

const HASH_A = `0x${'a'.repeat(64)}`
const HASH_B = `0x${'b'.repeat(64)}`
const ampleDisk = () => ({ bavail: 2_000_000_000, bsize: 4096 })
const receiptClock = () => new Date('2026-09-30T22:01:00.000Z')

function input({
  block = '26093000',
  hash = HASH_A,
  timestamp = 1790805600,
  observedAtUtc = '2026-09-30T22:00:30.000Z',
  instantUsd = null,
  depthUsd = null,
  totalAssets = '100000000000000000000',
} = {}) {
  return {
    venue: 'sUSDe',
    chain: 'ethereum',
    source: { block, hash, timestamp, finalized: true, pinned: true },
    observedAtUtc,
    params: {
      kind: 'erc4626-cooldown',
      totalAssets,
      depth_usd: depthUsd,
      read_block_finalized: true,
      read_block_pinned: true,
      read_block_number: block,
      read_block_hash: hash,
      read_block_time: timestamp,
    },
    instantUsd,
    coolingUsd: null,
    strandedUsd: null,
  }
}

test('database failure switches to the local sink exactly once', async () => {
  let localCalls = 0
  const result = await runDatabaseOrLocal(
    async () => {
      throw new Error('neon_quota_exceeded')
    },
    async () => {
      localCalls += 1
      return 'sealed'
    },
  )
  assert.deepEqual(result, { sink: 'local', result: 'sealed' })
  assert.equal(localCalls, 1)
  await assert.rejects(
    runDatabaseOrLocal(
      async () => {
        throw new Error('neon_quota_exceeded')
      },
      async () => {
        throw new Error('local_disk_full')
      },
    ),
    /local_disk_full/,
  )
})

test('exclusive writer token binds marker cleanup and sealed success; killed writer remains pending', () =>
  withOut((out) => {
    const identity = {
      venue: 'sUSDe',
      chain: 'ethereum',
      kind: 'vault',
      address: `0x${'1'.repeat(40)}`,
    }
    const tokenA = acquireLocalVenueSnapshotWriter(identity, out)
    markLocalVenueSnapshotAttempt(
      {
        identity,
        token: tokenA,
        attemptedAtUtc: '2026-09-30T22:00:00.000Z',
        status: 'capture_in_progress',
      },
      out,
    )
    assert.throws(() => acquireLocalVenueSnapshotWriter(identity, out), /writer_busy/)
    assert.equal(clearLocalVenueSnapshotAttempt('sUSDe', 'different-token', out), false)
    const sealed = appendLocalVenueSnapshot(input(), {
      out,
      stat: ampleDisk,
      now: receiptClock,
      localAttemptToken: tokenA,
    })
    assert.equal(sealed.record.localAttemptToken, tokenA)
    assert.equal(clearLocalVenueSnapshotAttempt('sUSDe', tokenA, out), true)
    assert.equal(releaseLocalVenueSnapshotWriter('sUSDe', tokenA, out), true)
    assert.equal(readLocalVenueSnapshotAttempt('sUSDe', identity, out), null)

    const killedToken = acquireLocalVenueSnapshotWriter(identity, out)
    assert.equal(
      readLocalVenueSnapshotAttempt('sUSDe', identity, out).status,
      'capture_in_progress',
    )
    markLocalVenueSnapshotAttempt(
      {
        identity,
        token: killedToken,
        attemptedAtUtc: '2026-09-30T22:03:00.000Z',
        status: 'capture_in_progress',
      },
      out,
    )
    assert.throws(() => acquireLocalVenueSnapshotWriter(identity, out), /writer_busy/)
    assert.equal(
      readLocalVenueSnapshotAttempt('sUSDe', identity, out).status,
      'capture_in_progress',
    )
  }))

test('snapshot reader rejects oversized physical records before parsing', () =>
  withOut((out) => {
    appendLocalVenueSnapshot(input(), { out, stat: ampleDisk, now: receiptClock })
    const path = join(out, 'sUSDe', '000000000001.json')
    const record = JSON.parse(readFileSync(path, 'utf8'))
    const { sha256: _oldHash, ...oldBody } = record
    const body = {
      ...oldBody,
      measurement: {
        ...oldBody.measurement,
        params: { ...oldBody.measurement.params, padding: 'x'.repeat(66_000) },
      },
    }
    const validLargeRecord = {
      ...body,
      sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    }
    writeFileSync(path, `${JSON.stringify(validLargeRecord)}\n`)
    assert.throws(() => verifyLocalVenueSnapshots('sUSDe', out), /local_snapshot_invalid_file/)
  }))

function withOut(fn) {
  const out = mkdtempSync(join(tmpdir(), 'venue-snapshots-test-'))
  try {
    return fn(out)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

test('database outage path can seal a finalized local baseline for every configured venue', () =>
  withOut((out) => {
    const venues = ['sUSDe', 'aave-v3-usde', 'sGHO', 'sUSDS', 'scrvUSD']
    const records = venues.map(
      (venue) =>
        appendLocalVenueSnapshot({ ...input(), venue }, { out, stat: ampleDisk, now: receiptClock })
          .record,
    )
    assert.equal(records.length, 5)
    for (const venue of venues) {
      const { count, last } = verifyLocalVenueSnapshots(venue, out)
      assert.equal(count, 1)
      assert.equal(last.source.block, '26093000')
      assert.equal(last.source.hash, HASH_A)
      assert.equal(last.observedAtUtc, '2026-09-30T22:00:30.000Z')
      assert.equal(last.firstLocalReceiptAtUtc, '2026-09-30T22:01:00.000Z')
      assert.equal(last.comparison.status, 'no_previous_observation')
      assert.equal(last.comparison.deltas, null)
      assert.equal(last.comparison.flowStatus, 'not_measured')
    }
  }))

test('a second point stores only measured deltas, never invented flow or a missing-value decline', () =>
  withOut((out) => {
    appendLocalVenueSnapshot(input(), { out, stat: ampleDisk, now: receiptClock })
    const next = appendLocalVenueSnapshot(
      input({
        block: '26093001',
        hash: HASH_B,
        timestamp: 1790805660,
        observedAtUtc: '2026-09-30T22:01:30.000Z',
        instantUsd: 0,
        depthUsd: 80,
        totalAssets: '90000000000000000000',
      }),
      {
        out,
        stat: ampleDisk,
        now: () => new Date('2026-09-30T22:02:00.000Z'),
      },
    ).record
    assert.equal(next.comparison.status, 'two_observed_points')
    assert.equal(next.comparison.elapsedSourceSeconds, 60)
    assert.equal(next.comparison.deltas.instantUsd, null)
    assert.equal(next.comparison.deltas.depthUsd, null)
    assert.equal(next.comparison.deltas.totalAssetsRaw.absolute, '-10000000000000000000')
    assert.equal(next.comparison.flowStatus, 'not_measured')
    assert.equal(next.comparison.continuity, 'not_established')
  }))

test('same finalized block is idempotent and never changes the first receipt', () =>
  withOut((out) => {
    const first = appendLocalVenueSnapshot(input(), {
      out,
      stat: ampleDisk,
      now: receiptClock,
    }).record
    const target = join(out, 'sUSDe', '000000000001.json')
    const bytes = readFileSync(target, 'utf8')
    const repeat = appendLocalVenueSnapshot(input({ observedAtUtc: '2026-09-30T22:00:40.000Z' }), {
      out,
      stat: ampleDisk,
      now: () => new Date('2026-09-30T22:03:00.000Z'),
    })
    assert.equal(repeat.status, 'already_recorded')
    assert.equal(repeat.record.sha256, first.sha256)
    assert.equal(readFileSync(target, 'utf8'), bytes)
    assert.equal(verifyLocalVenueSnapshots('sUSDe', out).count, 1)
  }))

test('failed publication leaves no partial receipt and a retry uses the same sequence', () =>
  withOut((out) => {
    assert.throws(
      () =>
        appendLocalVenueSnapshot(input(), {
          out,
          stat: ampleDisk,
          now: receiptClock,
          publish: () => {
            throw new Error('simulated_publish_failure')
          },
        }),
      /simulated_publish_failure/,
    )
    assert.deepEqual(readdirSync(join(out, 'sUSDe')), [])
    const retry = appendLocalVenueSnapshot(input(), {
      out,
      stat: ampleDisk,
      now: receiptClock,
    })
    assert.equal(retry.record.sequence, 1)
  }))

test('existing or tampered files are never overwritten', () =>
  withOut((out) => {
    appendLocalVenueSnapshot(input(), { out, stat: ampleDisk, now: receiptClock })
    const target = join(out, 'sUSDe', '000000000001.json')
    const bytes = readFileSync(target, 'utf8')
    assert.throws(
      () =>
        appendLocalVenueSnapshot(input({ block: '26093000', hash: HASH_B }), {
          out,
          stat: ampleDisk,
          now: receiptClock,
        }),
      /nonmonotonic_source/,
    )
    assert.equal(readFileSync(target, 'utf8'), bytes)
    writeFileSync(target, bytes.replace('sUSDe', 'xUSDe'))
    assert.throws(() => verifyLocalVenueSnapshots('sUSDe', out), /sha_mismatch/)
    assert.throws(
      () =>
        appendLocalVenueSnapshot(input({ block: '26093001', hash: HASH_B }), {
          out,
          stat: ampleDisk,
          now: receiptClock,
        }),
      /sha_mismatch/,
    )
  }))

test('resealed false decline or source mismatch fails offline verification and blocks append', () =>
  withOut((out) => {
    appendLocalVenueSnapshot(input({ instantUsd: 100 }), {
      out,
      stat: ampleDisk,
      now: receiptClock,
    })
    appendLocalVenueSnapshot(
      input({
        block: '26093001',
        hash: HASH_B,
        timestamp: 1790805660,
        observedAtUtc: '2026-09-30T22:01:30.000Z',
        instantUsd: 90,
      }),
      { out, stat: ampleDisk, now: () => new Date('2026-09-30T22:02:00.000Z') },
    )
    const target = join(out, 'sUSDe', '000000000002.json')
    const original = readFileSync(target, 'utf8')
    const tampered = JSON.parse(original)
    tampered.comparison.deltas.instantUsd.absolute = -100
    const { sha256: _old, ...body } = tampered
    tampered.sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    writeFileSync(target, `${JSON.stringify(tampered)}\n`)
    assert.throws(() => verifyLocalVenueSnapshots('sUSDe', out), /comparison_mismatch/)
    assert.throws(
      () =>
        appendLocalVenueSnapshot(
          input({
            block: '26093002',
            hash: HASH_A,
            timestamp: 1790805720,
            observedAtUtc: '2026-09-30T22:02:30.000Z',
          }),
          { out, stat: ampleDisk, now: () => new Date('2026-09-30T22:03:00.000Z') },
        ),
      /comparison_mismatch/,
    )
    writeFileSync(target, original)
    const sourceTampered = JSON.parse(original)
    sourceTampered.measurement.params.read_block_hash = HASH_A
    const { sha256: _oldSource, ...sourceBody } = sourceTampered
    sourceTampered.sha256 = createHash('sha256').update(JSON.stringify(sourceBody)).digest('hex')
    writeFileSync(target, `${JSON.stringify(sourceTampered)}\n`)
    assert.throws(() => verifyLocalVenueSnapshots('sUSDe', out), /unsealed_source/)
  }))

test('disk reserve prevents any publication', () =>
  withOut((out) => {
    assert.ok(MIN_LOCAL_SNAPSHOT_FREE_BYTES >= 1024 ** 3)
    assert.throws(
      () =>
        appendLocalVenueSnapshot(input(), {
          out,
          now: receiptClock,
          stat: () => ({ bavail: 1, bsize: 4096 }),
        }),
      /disk_reserve_reached/,
    )
    assert.deepEqual(readdirSync(out), [])
  }))
