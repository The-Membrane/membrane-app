import assert from 'node:assert/strict'
import test from 'node:test'
import { issueFirstBreach } from './aave-usde-first-breach.mjs'
import {
  bindFirstBreachIssue,
  buildFirstBreachSchedule,
  classifyFirstBreachSchedule,
  physicalSha256,
  verifyFirstBreachSchedule,
} from './aave-usde-first-breach-schedule.mjs'

const config = {
  name: 'aave-v3-usde',
  enabled: true,
  kind: 'atoken-liquidity',
  address: '0x4F5923Fc5FD4a93352581b38B7cD26943012DECF',
  underlying: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3',
  decimals: 18,
}
const startAt = '2026-09-29T00:00:00.000Z'
const plannedAt = '2026-09-28T23:00:00.000Z'
const endExclusiveAt = '2026-09-29T02:00:00.000Z'
const bytes = buildFirstBreachSchedule({ plannedAt, startAt, endExclusiveAt })
const expectedPhysicalSha256 = physicalSha256(bytes)
const manifest = verifyFirstBreachSchedule(bytes, expectedPhysicalSha256).manifest
const base = Date.parse('2026-09-28T00:00:00.000Z') / 1000
const iso = (seconds) => new Date(seconds * 1000).toISOString()
const sample = (i) => {
  const at = base + i * 4 * 3600
  const raw = 20_000_000n * 10n ** 18n
  return {
    id: `schedule-sample-${i}`,
    venue: 'aave-v3-usde',
    chain: 'ethereum',
    source: 'observed',
    recorder_atomic_v1: true,
    block: String(100 + i),
    observed_at: iso(at),
    created_at: iso(at),
    instant_usd: 20_000_000,
    params: {
      kind: 'atoken-liquidity',
      read_block_finalized: true,
      read_block_pinned: true,
      read_block_number: String(100 + i),
      read_block_hash: `0x${(100 + i).toString(16).padStart(64, '0')}`,
      read_block_time: at - 600,
      aToken: config.address,
      underlying: config.underlying,
      underlyingOnchain: config.underlying,
      underlyingIdentity: 'match',
      decimalsIdentity: 'match',
      decimals: 18,
      underlyingDecimalsOnchain: 18,
      reads: { underlyingAsset: true, underlyingDecimals: true, underlyingBalance: true },
      underlyingBalance: raw.toString(),
      priceAssumptionUsd: 1,
    },
  }
}
const history = Array.from({ length: 7 }, (_, i) => sample(i))
const issue = (overrides = {}) =>
  issueFirstBreach(history, {
    config,
    anchorId: 'schedule-sample-6',
    issuedAt: startAt,
    amountUsd: 10_000_000,
    horizonSeconds: 24 * 3600,
    ...overrides,
  })

test('canonical v2 schedule has nine arms per hourly slot and distinct study identity', () => {
  assert.equal(manifest.slots.length, 2)
  assert.equal(manifest.slots[0].arms.length, 9)
  assert.equal(manifest.slots[0].scheduledAt, startAt)
  assert.notEqual(manifest.slots[0].slotId, manifest.slots[1].slotId)
  assert.equal(manifest.study, 'aave-v3-usde-first-sampled-cash-breach-by-h-v2')
  assert.equal(
    verifyFirstBreachSchedule(bytes, expectedPhysicalSha256).physicalSha256,
    expectedPhysicalSha256,
  )
})

test('exact physical bytes, study, slots and nine arms are verified', () => {
  assert.throws(
    () => verifyFirstBreachSchedule(`${bytes}\n`, expectedPhysicalSha256),
    /physical SHA/,
  )
  assert.throws(() => verifyFirstBreachSchedule(bytes, '0'.repeat(64)), /physical SHA/)
  const altered = JSON.parse(bytes)
  altered.study = 'aave-v3-usde-prospective-sampled-cash-v1'
  const wrongStudy = JSON.stringify(altered)
  assert.throws(() => verifyFirstBreachSchedule(wrongStudy, physicalSha256(wrongStudy)), /study/)
  altered.study = manifest.study
  altered.slots[0].slotId = '0'.repeat(64)
  const wrongSlot = JSON.stringify(altered)
  assert.throws(() => verifyFirstBreachSchedule(wrongSlot, physicalSha256(wrongSlot)), /canonical/)
  altered.slots[0].slotId = manifest.slots[0].slotId
  altered.slots[0].arms.pop()
  const missingArm = JSON.stringify(altered)
  assert.throws(
    () => verifyFirstBreachSchedule(missingArm, physicalSha256(missingArm)),
    /canonical/,
  )
  altered.slots[0].arms.push({ ...altered.slots[0].arms[0] })
  const duplicateArm = JSON.stringify(altered)
  assert.throws(
    () => verifyFirstBreachSchedule(duplicateArm, physicalSha256(duplicateArm)),
    /canonical/,
  )
})

test('plan must precede aligned bounded future slots', () => {
  assert.equal(
    JSON.parse(
      buildFirstBreachSchedule({
        plannedAt,
        startAt,
        endExclusiveAt: new Date(Date.parse(startAt) + 568 * 3600_000).toISOString(),
      }),
    ).slots.length,
    568,
  )
  assert.throws(
    () =>
      buildFirstBreachSchedule({
        plannedAt,
        startAt,
        endExclusiveAt: new Date(Date.parse(startAt) + 569 * 3600_000).toISOString(),
      }),
    /bounded/,
  )
  assert.throws(
    () => buildFirstBreachSchedule({ plannedAt: startAt, startAt, endExclusiveAt }),
    /future/,
  )
  assert.throws(
    () =>
      buildFirstBreachSchedule({ plannedAt, startAt: '2026-09-29T00:01:00.000Z', endExclusiveAt }),
    /aligned/,
  )
  assert.throws(
    () =>
      buildFirstBreachSchedule({ plannedAt, startAt, endExclusiveAt: '2026-11-01T00:00:00.000Z' }),
    /bounded/,
  )
})

test('v2 issue must match the requested slot and fixed-grid arm', () => {
  const bound = bindFirstBreachIssue({
    scheduleBytes: bytes,
    expectedPhysicalSha256,
    slotId: manifest.slots[0].slotId,
    issue: issue(),
  })
  assert.equal(bound.membership, 'caller_consistent_only')
  assert.equal(bound.prospectiveEligible, false)
  assert.equal(bound.issueSchedulePhysicalSha256, expectedPhysicalSha256)
  assert.throws(
    () =>
      bindFirstBreachIssue({
        scheduleBytes: bytes,
        expectedPhysicalSha256,
        slotId: manifest.slots[1].slotId,
        issue: issue(),
      }),
    /outside scheduled slot/,
  )
  const descriptive = issue({ amountUsd: 7_000_000, horizonSeconds: 15 * 3600 })
  assert.throws(
    () =>
      bindFirstBreachIssue({
        scheduleBytes: bytes,
        expectedPhysicalSha256,
        slotId: manifest.slots[0].slotId,
        issue: descriptive,
      }),
    /Descriptive/,
  )
})

test('denominator retains issued, failed, scheduled and missing cells', () => {
  const firstSlot = manifest.slots[0].slotId
  const result = classifyFirstBreachSchedule({
    scheduleBytes: bytes,
    expectedPhysicalSha256,
    asOf: '2026-09-29T01:30:00.000Z',
    attempts: [
      {
        slotId: firstSlot,
        issueSchedulePhysicalSha256: expectedPhysicalSha256,
        amountUsd: 10_000_000,
        horizonSeconds: 24 * 3600,
        status: 'issued',
        issue: issue(),
        recordedAt: '2026-09-29T00:01:00.000Z',
      },
      {
        slotId: firstSlot,
        issueSchedulePhysicalSha256: expectedPhysicalSha256,
        amountUsd: 1_000_000,
        horizonSeconds: 8 * 3600,
        status: 'failed',
        reason: 'source_read_failed',
        recordedAt: '2026-09-29T00:02:00.000Z',
      },
    ],
  })
  assert.deepEqual(result.counts, {
    scheduled: 9,
    issued: 1,
    failed: 1,
    abstained: 0,
    duplicate: 0,
    missing: 7,
  })
  assert.equal(result.cells.length, 18)
  assert.equal(result.prospectiveEligible, false)
  assert.throws(
    () =>
      classifyFirstBreachSchedule({
        scheduleBytes: bytes,
        expectedPhysicalSha256,
        asOf: endExclusiveAt,
        attempts: [
          {
            slotId: firstSlot,
            issueSchedulePhysicalSha256: expectedPhysicalSha256,
            amountUsd: 7_000_000,
            horizonSeconds: 24 * 3600,
            status: 'failed',
            reason: 'x',
            recordedAt: startAt,
          },
        ],
      }),
    /outside scheduled slot or arm/,
  )
  const issued = {
    slotId: firstSlot,
    issueSchedulePhysicalSha256: expectedPhysicalSha256,
    amountUsd: 10_000_000,
    horizonSeconds: 24 * 3600,
    status: 'issued',
    issue: issue(),
    recordedAt: '2026-09-29T00:01:00.000Z',
  }
  const context = { scheduleBytes: bytes, expectedPhysicalSha256, asOf: endExclusiveAt }
  assert.throws(
    () => classifyFirstBreachSchedule({ ...context, attempts: [issued, issued] }),
    /Duplicate terminal/,
  )
  assert.throws(
    () =>
      classifyFirstBreachSchedule({
        ...context,
        attempts: [{ ...issued, recordedAt: '2026-09-29T01:00:00.000Z' }],
      }),
    /outside slot/,
  )
  assert.throws(
    () =>
      classifyFirstBreachSchedule({
        ...context,
        attempts: [{ ...issued, recordedAt: '2026-09-28T23:59:00.000Z' }],
      }),
    /outside slot/,
  )
  for (const malformed of [
    { amountUsd: '1000000', horizonSeconds: 8 * 3600 },
    { amountUsd: 1_000_000, horizonSeconds: '28800' },
  ])
    for (const status of ['failed', 'abstained'])
      assert.throws(
        () =>
          classifyFirstBreachSchedule({
            ...context,
            attempts: [
              {
                slotId: firstSlot,
                issueSchedulePhysicalSha256: expectedPhysicalSha256,
                ...malformed,
                status,
                reason: 'source_unavailable',
                recordedAt: startAt,
              },
            ],
          }),
        /exactly match scheduled numeric values/,
      )
})

test('abstention and duplicate remain separate caller-input denominator states', () => {
  const firstSlot = manifest.slots[0].slotId
  const result = classifyFirstBreachSchedule({
    scheduleBytes: bytes,
    expectedPhysicalSha256,
    asOf: endExclusiveAt,
    attempts: [
      {
        slotId: firstSlot,
        issueSchedulePhysicalSha256: expectedPhysicalSha256,
        amountUsd: 1_000_000,
        horizonSeconds: 8 * 3600,
        status: 'abstained',
        reason: 'anchor_below_amount',
        recordedAt: '2026-09-29T00:01:00.000Z',
      },
      {
        slotId: firstSlot,
        issueSchedulePhysicalSha256: expectedPhysicalSha256,
        amountUsd: 10_000_000,
        horizonSeconds: 24 * 3600,
        status: 'duplicate',
        issue: issue(),
        recordedAt: '2026-09-29T00:02:00.000Z',
      },
    ],
  })
  assert.equal(result.counts.abstained, 1)
  assert.equal(result.counts.duplicate, 1)
  assert.equal(result.counts.issued, 0)
  assert.equal(result.prospectiveEligible, false)
  const context = { scheduleBytes: bytes, expectedPhysicalSha256, asOf: endExclusiveAt }
  assert.throws(
    () =>
      classifyFirstBreachSchedule({
        ...context,
        attempts: [
          {
            slotId: firstSlot,
            issueSchedulePhysicalSha256: expectedPhysicalSha256,
            amountUsd: 1_000_000,
            horizonSeconds: 8 * 3600,
            status: 'abstained',
            reason: '',
            recordedAt: startAt,
          },
        ],
      }),
    /requires reason/,
  )
  assert.throws(
    () =>
      classifyFirstBreachSchedule({
        ...context,
        attempts: [
          {
            slotId: firstSlot,
            issueSchedulePhysicalSha256: expectedPhysicalSha256,
            amountUsd: 10_000_000,
            horizonSeconds: 24 * 3600,
            status: 'duplicate',
            recordedAt: startAt,
          },
        ],
      }),
    /lacks matching v2 issue/,
  )
  assert.throws(
    () =>
      classifyFirstBreachSchedule({
        ...context,
        attempts: [
          {
            slotId: firstSlot,
            issueSchedulePhysicalSha256: expectedPhysicalSha256,
            amountUsd: 1_000_000,
            horizonSeconds: 8 * 3600,
            status: 'duplicate',
            issue: issue(),
            recordedAt: startAt,
          },
        ],
      }),
    /same|arm|Issue/,
  )
})

test('overlapping calendars cannot reuse slot identity or attempt receipts', () => {
  const otherBytes = buildFirstBreachSchedule({
    plannedAt: '2026-09-28T22:00:00.000Z',
    startAt,
    endExclusiveAt,
  })
  const otherSha = physicalSha256(otherBytes)
  const other = verifyFirstBreachSchedule(otherBytes, otherSha).manifest
  assert.equal(other.slots[0].scheduledAt, manifest.slots[0].scheduledAt)
  assert.notEqual(other.slots[0].slotId, manifest.slots[0].slotId)
  const fromFirst = {
    issueSchedulePhysicalSha256: expectedPhysicalSha256,
    slotId: manifest.slots[0].slotId,
    amountUsd: 1_000_000,
    horizonSeconds: 8 * 3600,
    status: 'failed',
    reason: 'source_unavailable',
    recordedAt: startAt,
  }
  const context = {
    scheduleBytes: otherBytes,
    expectedPhysicalSha256: otherSha,
    asOf: endExclusiveAt,
  }
  assert.throws(
    () => classifyFirstBreachSchedule({ ...context, attempts: [fromFirst] }),
    /physical SHA binding/,
  )
  assert.throws(
    () =>
      classifyFirstBreachSchedule({
        ...context,
        attempts: [{ ...fromFirst, issueSchedulePhysicalSha256: otherSha }],
      }),
    /outside scheduled slot or arm/,
  )
})
