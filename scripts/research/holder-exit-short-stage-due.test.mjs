import assert from 'node:assert/strict'
import test from 'node:test'

import { readVerifiedShortStageDue, selectShortStageDue } from './holder-exit-short-stage-due.mjs'

const target = (horizonHours, targetAtUtc, deadlineAtUtc) => ({
  horizonHours,
  targetAtUtc,
  deadlineAtUtc,
})
const at = (iso) => Date.parse(iso)
const laneDue = (
  lane,
  live,
  expired,
  nextLiveDeadlineMs = null,
  nextLiveTargetMs = null,
  nextExpiredDeadlineMs = null,
) => ({ lane, live, expired, nextLiveDeadlineMs, nextLiveTargetMs, nextExpiredDeadlineMs })

test('verified short-stage selector protects open H1 before overdue targets', () => {
  const nowMs = Date.parse('2026-10-04T06:00:00.000Z')
  const sources = [
    {
      lane: 'fluid_bridge_usdc_score',
      issues: [
        {
          sequence: 1,
          targets: [target(24, '2026-10-02T00:00:00.000Z', '2026-10-02T02:00:00.000Z')],
        },
      ],
      scores: [],
    },
    {
      lane: 'fluid_bridge_usdt_score',
      issues: [
        {
          sequence: 1,
          targets: [target(1, '2026-10-04T05:00:00.000Z', '2026-10-04T07:00:00.000Z')],
        },
      ],
      scores: [],
    },
  ]
  const due = selectShortStageDue(sources, nowMs)
  assert.equal(due.nextLiveLane, 'fluid_bridge_usdt_score')
  assert.equal(due.nextLiveDeadlineMs, Date.parse('2026-10-04T07:00:00.000Z'))
  assert.equal(due.nextExpiredLane, 'fluid_bridge_usdc_score')
  assert.deepEqual(due.byLane, [
    laneDue(
      'fluid_bridge_usdt_score',
      1,
      0,
      at('2026-10-04T07:00:00.000Z'),
      at('2026-10-04T05:00:00.000Z'),
    ),
    laneDue('fluid_bridge_usdc_score', 0, 1, null, null, at('2026-10-02T02:00:00.000Z')),
  ])
  sources[1].scores.push({ issueSequence: 1, horizonHours: 1 })
  assert.equal(selectShortStageDue(sources, nowMs).nextLiveLane, null)
})

test('short-stage selector accepts fToken deadlineUtc and ignores future targets', () => {
  const nowMs = Date.parse('2026-10-04T06:00:00.000Z')
  const due = selectShortStageDue(
    [
      {
        lane: 'fluid_ftoken_score',
        issues: [
          {
            sequence: 1,
            targets: [
              {
                horizonHours: 1,
                targetAtUtc: '2026-10-04T05:30:00.000Z',
                deadlineUtc: '2026-10-04T07:30:00.000Z',
              },
              {
                horizonHours: 4,
                targetAtUtc: '2026-10-04T08:30:00.000Z',
                deadlineUtc: '2026-10-04T10:30:00.000Z',
              },
            ],
          },
        ],
        scores: [],
      },
    ],
    nowMs,
  )
  assert.deepEqual(due.byLane, [
    laneDue(
      'fluid_ftoken_score',
      1,
      0,
      at('2026-10-04T07:30:00.000Z'),
      at('2026-10-04T05:30:00.000Z'),
    ),
  ])
})

test('Compound captureDeadlineUtc preserves an exact original-asset live window', () => {
  const due = selectShortStageDue(
    [
      {
        lane: 'compound_holder_score',
        issues: [
          {
            sequence: 1,
            targets: [
              {
                horizonHours: 1,
                targetAtUtc: '2026-10-04T05:00:00.000Z',
                captureDeadlineUtc: '2026-10-04T07:00:00.000Z',
              },
            ],
          },
        ],
        scores: [],
      },
    ],
    at('2026-10-04T06:00:00.000Z'),
  )
  assert.deepEqual(due.byLane, [
    laneDue(
      'compound_holder_score',
      1,
      0,
      at('2026-10-04T07:00:00.000Z'),
      at('2026-10-04T05:00:00.000Z'),
    ),
  ])
})

test('USD3 live deadline participates in the same bounded selector', () => {
  const due = selectShortStageDue(
    [
      {
        lane: 'usd3_holder_score',
        issues: [
          {
            sequence: 1,
            targets: [
              {
                horizonHours: 1,
                targetAtUtc: '2026-10-04T05:00:00.000Z',
                captureDeadlineUtc: '2026-10-04T07:00:00.000Z',
              },
            ],
          },
        ],
        scores: [],
      },
    ],
    at('2026-10-04T06:00:00.000Z'),
  )
  assert.equal(due.nextLiveLane, 'usd3_holder_score')
  assert.equal(due.byLane[0].nextLiveDeadlineMs, at('2026-10-04T07:00:00.000Z'))
})

test('frozen USDS wrapper deadlines outrank older expired censors', () => {
  const due = selectShortStageDue(
    [
      {
        lane: 'stusds_holder_score',
        issues: [
          {
            sequence: 1,
            targets: [
              {
                horizonHours: 1,
                targetAtUtc: '2026-10-04T05:00:00.000Z',
                captureDeadlineUtc: '2026-10-04T07:00:00.000Z',
              },
            ],
          },
        ],
        scores: [],
      },
      {
        lane: 'susds_holder_score',
        issues: [
          {
            sequence: 2,
            targets: [
              {
                horizonHours: 4,
                targetAtUtc: '2026-10-02T05:00:00.000Z',
                captureDeadlineUtc: '2026-10-02T07:00:00.000Z',
              },
            ],
          },
        ],
        scores: [],
      },
    ],
    at('2026-10-04T06:00:00.000Z'),
  )
  assert.equal(due.nextLiveLane, 'stusds_holder_score')
  assert.equal(due.nextExpiredLane, 'susds_holder_score')
})

test('Spark USDT capture deadline enters the exact short-stage selector', () => {
  const due = selectShortStageDue(
    [
      {
        lane: 'spark_usdt_holder_score',
        issues: [
          {
            sequence: 12,
            targets: [
              {
                horizonHours: 1,
                targetAtUtc: '2026-10-04T05:00:00.000Z',
                captureDeadlineUtc: '2026-10-04T07:00:00.000Z',
              },
            ],
          },
        ],
        scores: [],
      },
    ],
    at('2026-10-04T06:00:00.000Z'),
  )
  assert.equal(due.nextLiveLane, 'spark_usdt_holder_score')
  assert.equal(due.nextLiveDeadlineMs, at('2026-10-04T07:00:00.000Z'))
})

test('Aave direct due targets enter both market lanes without cross-market score collisions', async () => {
  const empty = { issues: [], scores: [] }
  const issue = (sequence, marketKey) => ({
    sequence,
    marketKey,
    cases: [{ status: 'measured', measurement: { status: 'success' } }],
    targets: [target(1, '2026-10-04T05:00:00.000Z', '2026-10-04T07:00:00.000Z')],
  })
  const due = await readVerifiedShortStageDue(at('2026-10-04T06:00:00.000Z'), {
    bridgeUsdc: async () => empty,
    bridgeUsdt: async () => empty,
    twyne: async () => empty,
    ftokenRoute: async () => empty,
    compound: async () => empty,
    usd3: async () => empty,
    stusds: async () => empty,
    susds: async () => empty,
    sparkUsdt: async () => empty,
    umbrellaGho: async () => empty,
    sgho: async () => empty,
    sghoFixedQ: async () => empty,
    hastraPrime: async () => empty,
    sghoFixedQParents: async () => [],
    aaveDirect: async () => ({
      issues: [issue(1, 'aaveV3Usdc'), issue(2, 'aaveV3Usde')],
      scores: [{ issueSequence: 1, horizonHours: 1, marketKey: 'aaveV3Usdc' }],
    }),
  })
  assert.equal(due.nextLiveLane, 'aave_usde_holder_score')
  assert.deepEqual(
    due.byLane.map((row) => row.lane),
    ['aave_usde_holder_score'],
  )
})

test('Hastra PRIME to wYLDS first-stage deadline enters the live selector', () => {
  const due = selectShortStageDue(
    [
      {
        lane: 'hastra_prime_score',
        issues: [
          {
            sequence: 4,
            targets: [target(1, '2026-10-04T05:00:00.000Z', '2026-10-04T07:00:00.000Z')],
          },
        ],
        scores: [],
      },
    ],
    at('2026-10-04T06:00:00.000Z'),
  )
  assert.equal(due.nextLiveLane, 'hastra_prime_score')
  assert.equal(due.nextLiveDeadlineMs, at('2026-10-04T07:00:00.000Z'))
})

test('Umbrella GHO cooldown horizon enters the live selector', () => {
  const due = selectShortStageDue(
    [
      {
        lane: 'umbrella_gho_holder_score',
        issues: [
          {
            sequence: 4,
            targets: [
              {
                horizonHours: 24,
                targetAtUtc: '2026-10-04T05:00:00.000Z',
                deadlineUtc: '2026-10-04T07:00:00.000Z',
              },
            ],
          },
        ],
        scores: [],
      },
    ],
    at('2026-10-04T06:00:00.000Z'),
  )
  assert.equal(due.nextLiveLane, 'umbrella_gho_holder_score')
})

test('linked sGHO fixed-Q issue is urgent until its baseline plus 45-minute deadline', async () => {
  const nowMs = at('2026-10-04T06:00:00.000Z')
  const empty = { issues: [], scores: [] }
  const due = await readVerifiedShortStageDue(nowMs, {
    bridgeUsdc: async () => empty,
    bridgeUsdt: async () => empty,
    twyne: async () => empty,
    ftokenRoute: async () => empty,
    compound: async () => empty,
    usd3: async () => empty,
    stusds: async () => empty,
    susds: async () => empty,
    sparkUsdt: async () => empty,
    aaveDirect: async () => empty,
    umbrellaGho: async () => empty,
    sgho: async () => empty,
    sghoFixedQ: async () => empty,
    hastraPrime: async () => empty,
    sghoFixedQParents: async () => [
      {
        parent: { baseline: { targetBlockAt: '2026-10-04T05:25:00.000Z' } },
        issueDeadlineUtc: '2026-10-04T06:10:00.000Z',
      },
    ],
  })
  assert.equal(due.nextLiveLane, 'sgho_fixed_q_issue')
  assert.equal(due.nextLiveDeadlineMs, at('2026-10-04T06:10:00.000Z'))
  assert.deepEqual(due.verificationFailedLanes, [])
})

test('short-stage intake uses injected verified ledgers without network', async () => {
  const nowMs = Date.parse('2026-10-04T06:00:00.000Z')
  const empty = { issues: [], scores: [] }
  let calls = 0
  let targetReads = 0
  const bridgeUsdc = async () => {
    calls++
    return {
      issues: [
        {
          sequence: 1,
          targets: [
            {
              horizonHours: 1,
              get targetAtUtc() {
                targetReads++
                return '2026-10-04T05:00:00.000Z'
              },
              deadlineAtUtc: '2026-10-04T07:00:00.000Z',
            },
          ],
        },
      ],
      scores: [],
    }
  }
  const due = await readVerifiedShortStageDue(nowMs, {
    bridgeUsdc,
    bridgeUsdt: async () => empty,
    twyne: async () => empty,
    ftokenRoute: async () => empty,
    compound: async () => empty,
    usd3: async () => empty,
    stusds: async () => empty,
    susds: async () => empty,
    sparkUsdt: async () => empty,
    aaveDirect: async () => empty,
    umbrellaGho: async () => empty,
    sgho: async () => empty,
    sghoFixedQ: async () => empty,
    hastraPrime: async () => empty,
    sghoFixedQParents: async () => [],
  })
  assert.equal(calls, 1)
  assert.equal(targetReads, 1)
  assert.equal(due.nextLiveLane, 'fluid_bridge_usdc_score')
  assert.deepEqual(due.verificationFailedLanes, [])
})

test('three fToken sources aggregate without cross-route score collisions and keep earliest target on a deadline tie', async () => {
  const nowMs = at('2026-10-04T06:00:00.000Z')
  const empty = { issues: [], scores: [] }
  const routes = [
    {
      issues: [
        {
          sequence: 1,
          targets: [
            target(1, '2026-10-04T05:00:00.000Z', '2026-10-04T07:00:00.000Z'),
            target(4, '2026-10-02T05:00:00.000Z', '2026-10-02T07:00:00.000Z'),
          ],
        },
      ],
      scores: [{ issueSequence: 1, horizonHours: 1 }],
    },
    {
      issues: [
        {
          sequence: 1,
          targets: [target(1, '2026-10-04T05:40:00.000Z', '2026-10-04T07:00:00.000Z')],
        },
      ],
      scores: [],
    },
    {
      issues: [
        {
          sequence: 1,
          targets: [target(1, '2026-10-04T05:20:00.000Z', '2026-10-04T07:00:00.000Z')],
        },
      ],
      scores: [],
    },
  ]
  const due = await readVerifiedShortStageDue(nowMs, {
    bridgeUsdc: async () => empty,
    bridgeUsdt: async () => empty,
    twyne: async () => empty,
    ftokenRoute: async (routeIndex) => routes[routeIndex],
    compound: async () => empty,
    usd3: async () => empty,
    stusds: async () => empty,
    susds: async () => empty,
    sparkUsdt: async () => empty,
    aaveDirect: async () => empty,
    umbrellaGho: async () => empty,
    sgho: async () => empty,
    sghoFixedQ: async () => empty,
    hastraPrime: async () => empty,
    sghoFixedQParents: async () => [],
  })
  assert.deepEqual(due.byLane, [
    laneDue(
      'fluid_ftoken_score',
      2,
      1,
      at('2026-10-04T07:00:00.000Z'),
      at('2026-10-04T05:20:00.000Z'),
      at('2026-10-02T07:00:00.000Z'),
    ),
  ])
  assert.deepEqual(due.verificationFailedLanes, [])
})

test('a malformed fToken source contributes no partial summary to other routes', async () => {
  const nowMs = at('2026-10-04T06:00:00.000Z')
  const empty = { issues: [], scores: [] }
  const due = await readVerifiedShortStageDue(nowMs, {
    bridgeUsdc: async () => empty,
    bridgeUsdt: async () => empty,
    twyne: async () => empty,
    ftokenRoute: async (routeIndex) => ({
      issues: [
        {
          sequence: 1,
          targets: [
            target(1, '2026-10-04T05:00:00.000Z', '2026-10-04T07:00:00.000Z'),
            ...(routeIndex === 1 ? [target(4, 'bad-clock', '2026-10-04T08:00:00.000Z')] : []),
          ],
        },
      ],
      scores: [],
    }),
    compound: async () => empty,
    usd3: async () => empty,
    stusds: async () => empty,
    susds: async () => empty,
    sparkUsdt: async () => empty,
    aaveDirect: async () => empty,
    umbrellaGho: async () => empty,
    sgho: async () => empty,
    sghoFixedQ: async () => empty,
    hastraPrime: async () => empty,
    sghoFixedQParents: async () => [],
  })
  assert.deepEqual(due.byLane, [
    laneDue(
      'fluid_ftoken_score',
      2,
      0,
      at('2026-10-04T07:00:00.000Z'),
      at('2026-10-04T05:00:00.000Z'),
    ),
  ])
  assert.deepEqual(due.verificationFailedLanes, ['fluid_ftoken_score'])
})

test('a failed source leaves verified live targets in other lanes runnable', async () => {
  const nowMs = Date.parse('2026-10-04T06:00:00.000Z')
  const empty = { issues: [], scores: [] }
  const due = await readVerifiedShortStageDue(nowMs, {
    bridgeUsdc: async () => ({
      issues: [
        {
          sequence: 1,
          targets: [target(1, '2026-10-04T05:00:00.000Z', '2026-10-04T07:00:00.000Z')],
        },
      ],
      scores: [],
    }),
    bridgeUsdt: async () => {
      throw Error('corrupt_ledger')
    },
    twyne: async () => empty,
    ftokenRoute: async (routeIndex) => {
      if (routeIndex === 1) throw Error('corrupt_route')
      return empty
    },
    compound: async () => empty,
    usd3: async () => empty,
    stusds: async () => empty,
    susds: async () => empty,
    sparkUsdt: async () => empty,
    aaveDirect: async () => empty,
    umbrellaGho: async () => empty,
    sgho: async () => empty,
    sghoFixedQ: async () => empty,
    hastraPrime: async () => empty,
    sghoFixedQParents: async () => [],
  })
  assert.equal(due.nextLiveLane, 'fluid_bridge_usdc_score')
  assert.deepEqual(due.verificationFailedLanes, ['fluid_bridge_usdt_score', 'fluid_ftoken_score'])
})

test('bad StUsds ledger cannot mask a still-open SUsds window', async () => {
  const empty = { issues: [], scores: [] }
  const result = await readVerifiedShortStageDue(at('2026-10-04T06:00:00.000Z'), {
    bridgeUsdc: async () => empty,
    bridgeUsdt: async () => empty,
    twyne: async () => empty,
    ftokenRoute: async () => empty,
    compound: async () => empty,
    usd3: async () => empty,
    stusds: async () => {
      throw Error('corrupt_stusds_ledger')
    },
    susds: async () => ({
      issues: [
        {
          sequence: 1,
          targets: [
            {
              horizonHours: 1,
              targetAtUtc: '2026-10-04T05:00:00.000Z',
              captureDeadlineUtc: '2026-10-04T07:00:00.000Z',
            },
          ],
        },
      ],
      scores: [],
    }),
    sparkUsdt: async () => empty,
    aaveDirect: async () => empty,
    umbrellaGho: async () => empty,
    sgho: async () => empty,
    sghoFixedQ: async () => empty,
    hastraPrime: async () => empty,
    sghoFixedQParents: async () => [],
  })
  assert.equal(result.nextLiveLane, 'susds_holder_score')
  assert.deepEqual(result.verificationFailedLanes, ['stusds_holder_score'])
})

test('historical scored targets do not exhaust a fixed selector budget', () => {
  const nowMs = Date.parse('2026-10-04T06:00:00.000Z')
  const issues = Array.from({ length: 4_100 }, (_, index) => ({
    sequence: index + 1,
    targets: [target(1, '2026-10-02T05:00:00.000Z', '2026-10-02T07:00:00.000Z')],
  }))
  const scores = issues.map((issue) => ({ issueSequence: issue.sequence, horizonHours: 1 }))
  assert.deepEqual(
    selectShortStageDue([{ lane: 'fluid_bridge_usdc_score', issues, scores }], nowMs).byLane,
    [],
  )
})

test('malformed target clocks fail closed', () => {
  assert.throws(
    () =>
      selectShortStageDue(
        [
          {
            lane: 'fluid_ftoken_score',
            issues: [
              {
                sequence: 1,
                targets: [target(1, 'bad-clock', '2026-10-04T07:00:00.000Z')],
              },
            ],
            scores: [],
          },
        ],
        Date.parse('2026-10-04T06:00:00.000Z'),
      ),
    /holder_short_stage_target_invalid/,
  )
})
