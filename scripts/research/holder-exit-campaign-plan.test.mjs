import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ASSAY_MS,
  apyUsdFailedStages,
  campaignCommandForLane,
  chooseCampaignLane,
  chooseLightCampaignLane,
  hasFreshVerifiedDirectFlowPair,
  HOURLY_MS,
  nextFreshLightDirectIssueLane,
  readCampaignEvidence,
  readCampaignState,
  runLightCampaignTick,
  runPriorityTargetTick,
  SLOT_MS,
  summarizeH1CashTargetDue,
  writeCampaignState,
} from './holder-exit-campaign-plan.mjs'

const choose = (slot, overrides = {}) =>
  chooseCampaignLane({
    nowMs: slot * SLOT_MS,
    archiveComplete: false,
    episodeAttested: false,
    joinedSourceAvailable: true,
    lastAttempts: {},
    ...overrides,
  })

const cashIssueAt = (issuedAt = '2026-10-05T05:05:00.000Z') => ({
  kind: 'issue',
  slotAt: '2026-10-05T05:00:00.000Z',
  issuedAt,
  attempts: [
    {
      routeKey: 'USDC → supply on Aave V3',
      destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
      asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      horizonHours: 1,
      status: 'issued',
      targetAt: '2026-10-05T06:05:00.000Z',
      targetLowAt: '2026-10-05T05:50:00.000Z',
      targetHighAt: '2026-10-05T06:20:00.000Z',
      source: {
        blockAt: '2026-10-05T05:00:00.000Z',
        assetDecimals: 6,
      },
    },
  ],
})

const cashObservationAt = (
  blockAt = '2026-10-05T06:02:00.000Z',
  firstLocalReceiptAt = '2026-10-05T06:04:00.000Z',
) => ({
  collectionMode: 'current',
  evidenceKind: 'current_finalized_observation',
  source: { blockAt },
  firstLocalReceiptAt,
  subjects: [
    {
      routeKey: 'USDC → supply on Aave V3',
      destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
      state: 'observed',
      asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      assetDecimals: 6,
      cashRaw: '1000',
    },
  ],
})

test('ApyUSD exit mask identifies only failed capture stages', () => {
  assert.deepEqual(apyUsdFailedStages(0), [])
  assert.deepEqual(apyUsdFailedStages(65), ['receipt_intake'])
  assert.deepEqual(apyUsdFailedStages(66), ['receipt_forceability'])
  assert.deepEqual(apyUsdFailedStages(68), ['impairment_followup'])
  assert.deepEqual(apyUsdFailedStages(72), ['receipt_outcomes'])
  assert.deepEqual(apyUsdFailedStages(69), ['receipt_intake', 'impairment_followup'])
  assert.deepEqual(apyUsdFailedStages(79), [
    'receipt_intake',
    'receipt_forceability',
    'impairment_followup',
    'receipt_outcomes',
  ])
  for (const status of [-1, 1, 2, 15, 64, 80, 124, null, 1.5])
    assert.equal(apyUsdFailedStages(status), null)
})

test('priority target tick is quiet when no watch or target window needs work', async () => {
  assert.deepEqual(await runPriorityTargetTick(0, async () => null), {
    handled: false,
    ok: true,
    failedLanes: [],
    blockedLanes: [],
    errored: false,
  })
})

test('an H1 cash window outranks a later-closing live holder target', () => {
  const issue = cashIssueAt()
  const nowMs = Date.parse('2026-10-05T05:55:00.000Z')
  const h1CashTarget = summarizeH1CashTargetDue({ records: [issue], observations: [] }, nowMs)
  assert.deepEqual(h1CashTarget, {
    due: true,
    liveWindows: 1,
    missingAttempts: 1,
    nextTargetHighMs: Date.parse('2026-10-05T06:20:00.000Z'),
    nextReceiptDeadlineMs: Date.parse('2026-10-05T07:20:00.000Z'),
  })
  assert.equal(
    chooseCampaignLane({
      nowMs,
      archiveComplete: true,
      episodeAttested: false,
      joinedSourceAvailable: false,
      h1CashTarget,
      shortStage: {
        byLane: [
          {
            lane: 'fluid_bridge_usdt_score',
            live: 1,
            expired: 0,
            nextLiveTargetMs: nowMs - SLOT_MS,
            nextLiveDeadlineMs: Date.parse('2026-10-05T06:30:00.000Z'),
          },
        ],
      },
      lastAttempts: { all_subject_cash: nowMs },
    }),
    'all_subject_cash',
  )
})

test('a live holder target outranks H1 cash when its deadline closes first or ties', () => {
  const nowMs = Date.parse('2026-10-05T05:55:00.000Z')
  const h1CashTarget = summarizeH1CashTargetDue(
    { records: [cashIssueAt()], observations: [] },
    nowMs,
  )
  for (const deadline of ['2026-10-05T06:05:00.000Z', '2026-10-05T06:20:00.000Z'])
    assert.equal(
      chooseCampaignLane({
        nowMs,
        archiveComplete: true,
        episodeAttested: false,
        joinedSourceAvailable: false,
        h1CashTarget,
        shortStage: {
          byLane: [
            {
              lane: 'fluid_bridge_usdt_score',
              live: 1,
              expired: 0,
              nextLiveTargetMs: nowMs - SLOT_MS,
              nextLiveDeadlineMs: Date.parse(deadline),
            },
          ],
        },
      }),
      'fluid_bridge_usdt_score',
    )
})

test('a qualifying current observation clears H1 priority without changing normal scheduling', () => {
  const issue = cashIssueAt()
  const nowMs = Date.parse('2026-10-05T06:05:00.000Z')
  const withoutCashTarget = chooseCampaignLane({
    nowMs,
    archiveComplete: false,
    episodeAttested: false,
    joinedSourceAvailable: true,
    lastAttempts: {},
  })
  const h1CashTarget = summarizeH1CashTargetDue(
    { records: [issue], observations: [cashObservationAt()] },
    nowMs,
  )
  assert.deepEqual(h1CashTarget, {
    due: false,
    liveWindows: 0,
    missingAttempts: 0,
    nextTargetHighMs: null,
    nextReceiptDeadlineMs: null,
  })
  assert.equal(
    chooseCampaignLane({
      nowMs,
      archiveComplete: false,
      episodeAttested: false,
      joinedSourceAvailable: true,
      h1CashTarget,
      lastAttempts: {},
    }),
    withoutCashTarget,
  )
})

test('H1 cash priority rejects future, retrospective and expired target evidence', () => {
  const issue = cashIssueAt()
  const inWindow = Date.parse('2026-10-05T06:05:00.000Z')
  const future = cashObservationAt('2026-10-05T06:02:00.000Z', '2026-10-05T06:06:00.000Z')
  const retrospective = { ...cashObservationAt(), collectionMode: 'retrospective' }
  assert.equal(
    summarizeH1CashTargetDue({ records: [issue], observations: [future, retrospective] }, inWindow)
      .due,
    true,
  )
  assert.equal(
    summarizeH1CashTargetDue(
      { records: [issue], observations: [] },
      Date.parse('2026-10-05T07:20:00.000Z'),
    ).due,
    false,
  )
  assert.equal(
    summarizeH1CashTargetDue(
      {
        records: [
          issue,
          { kind: 'score', issueSlotAt: issue.slotAt, horizonHours: 1, attempts: [] },
        ],
        observations: [],
      },
      inWindow,
    ).due,
    false,
  )
})

test('full-mode evidence carries verified H1 priority and fails closed on ledger errors', async () => {
  const common = {
    archiveReader: async () => ({ summary: { complete: false } }),
    shortStageReader: async () => ({ byLane: [] }),
    joinedEndpointReader: async () => null,
  }
  const due = {
    due: true,
    liveWindows: 1,
    missingAttempts: 66,
    nextTargetHighMs: 3 * SLOT_MS,
  }
  const evidence = await readCampaignEvidence(2 * SLOT_MS, {
    ...common,
    h1CashTargetReader: async () => due,
  })
  assert.equal(evidence.h1CashTarget, due)
  assert.equal(evidence.h1CashTargetVerificationFailed, false)

  const failed = await readCampaignEvidence(2 * SLOT_MS, {
    ...common,
    h1CashTargetReader: async () => {
      throw Error('corrupt_local_cash_ledger')
    },
  })
  assert.equal(failed.h1CashTarget, null)
  assert.equal(failed.h1CashTargetVerificationFailed, true)
  assert.notEqual(chooseCampaignLane({ nowMs: 2 * SLOT_MS, ...failed }), 'all_subject_cash')

  const missingDeadline = await readCampaignEvidence(2 * SLOT_MS, {
    ...common,
    h1CashTargetReader: async () => ({ due: true }),
  })
  assert.equal(missingDeadline.h1CashTarget, null)
  assert.equal(missingDeadline.h1CashTargetVerificationFailed, true)
})

test('priority target work preempts the routine light campaign lane', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'holder-exit-priority-target-'))
  const path = join(dir, 'state.json')
  const calls = []
  try {
    const ok = await runLightCampaignTick({
      nowMs: 3 * SLOT_MS,
      statePath: path,
      targetTick: async () => ({ scrvusd: null, morpho: { status: 'ran' } }),
      shortStageReader: async () => ({ byLane: [] }),
      spawn: (...args) => {
        calls.push(args)
        return { status: 0, error: null, signal: null }
      },
    })
    assert.equal(ok, true)
    assert.equal(calls.length, 0)
    assert.deepEqual(readCampaignState(path), { lastAttempts: {} })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('failed priority target work fails the campaign tick', async () => {
  assert.deepEqual(
    await runPriorityTargetTick(0, async () => ({
      scrvusd: null,
      morpho: { status: 'worker_failed', detail: 'https://rpc.example/private-token' },
    })),
    {
      handled: true,
      ok: false,
      failedLanes: ['morpho'],
      blockedLanes: [],
      errored: false,
    },
  )
})

test('one failed target lane backs off without blocking the other target lane', async () => {
  let received
  assert.deepEqual(
    await runPriorityTargetTick(
      2 * SLOT_MS,
      async (_nowMs, options) => {
        received = options
        return { scrvusd: null, morpho: { status: 'ran' } }
      },
      { scrvusd: SLOT_MS },
    ),
    {
      handled: true,
      ok: true,
      failedLanes: [],
      blockedLanes: ['scrvusd'],
      errored: false,
    },
  )
  assert.deepEqual(received, { blockedLanes: ['scrvusd'] })
})

test('campaign persists target failure and gives the next slot to routine evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'holder-exit-target-backoff-'))
  const path = join(dir, 'state.json')
  const calls = []
  try {
    const failed = await runLightCampaignTick({
      nowMs: 2 * SLOT_MS,
      statePath: path,
      targetTick: async () => ({ scrvusd: { status: 'target_tick_failed' }, morpho: null }),
      shortStageReader: async () => ({ byLane: [] }),
      spawn: () => {
        throw Error('routine_must_not_run_on_failure_tick')
      },
    })
    assert.equal(failed, false)
    assert.equal(readCampaignState(path).lastAttempts.priority_scrvusd_failure, 2 * SLOT_MS)

    let received
    const recovered = await runLightCampaignTick({
      nowMs: 3 * SLOT_MS,
      statePath: path,
      targetTick: async (_nowMs, options) => {
        received = options
        return null
      },
      shortStageReader: async () => ({ byLane: [] }),
      spawn: (...args) => {
        calls.push(args)
        return { status: 0, error: null, signal: null }
      },
    })
    assert.equal(recovered, true)
    assert.deepEqual(received, { blockedLanes: ['scrvusd'] })
    assert.equal(calls.length, 1)
    assert.match(calls[0][1].join(' '), /carry-apyusd-prospective-intake-tick\.sh/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('target dispatcher exception still runs routine work but fails the campaign tick', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'holder-exit-target-error-'))
  const path = join(dir, 'state.json')
  const calls = []
  try {
    const ok = await runLightCampaignTick({
      nowMs: 3 * SLOT_MS,
      statePath: path,
      targetTick: async () => {
        throw Error('target_dispatcher_failed')
      },
      shortStageReader: async () => ({ byLane: [] }),
      spawn: (...args) => {
        calls.push(args)
        return { status: 0, error: null, signal: null }
      },
    })
    assert.equal(ok, false)
    assert.equal(calls.length, 1)
    assert.match(calls[0][1].join(' '), /carry-apyusd-prospective-intake-tick\.sh/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unfinished sUSDe archive leaves direct, Aave and Morpho holder slots open', () => {
  for (const slot of [1, 7]) assert.equal(choose(slot), 'direct_flow')
  for (const slot of [2, 8]) assert.equal(choose(slot), 'aave_holder')
  for (const slot of [0, 4, 6, 10]) assert.equal(choose(slot), 'morpho_v2_score')
  assert.equal(choose(5), 'saturn_pending_series')
  assert.equal(
    choose(11, {
      lastAttempts: { apyusd_frozen_open: 3 * SLOT_MS, saturn_pending_series: 5 * SLOT_MS },
    }),
    'morpho_v2_issue_api',
  )
  assert.equal(choose(2, { joinedSourceAvailable: false }), 'susde_archive')
  assert.equal(choose(3), 'apyusd_prospective_intake')
  assert.equal(
    choose(9, { lastAttempts: { apyusd_prospective_intake: 3 * SLOT_MS } }),
    'apyusd_frozen_open',
  )
  assert.equal(
    choose(15, {
      lastAttempts: {
        apyusd_prospective_intake: 3 * SLOT_MS,
        apyusd_frozen_open: 9 * SLOT_MS,
      },
    }),
    'susde_archive',
  )
})

test('an unfinished archive still advances during a full day of scheduled holder work', () => {
  const lastAttempts = {}
  const counts = {}
  for (let slot = 0; slot < 144; slot++) {
    const lane = choose(slot, { lastAttempts })
    counts[lane] = (counts[lane] ?? 0) + 1
    if (lane !== 'susde_archive' && lane !== 'morpho_v2_score') lastAttempts[lane] = slot * SLOT_MS
  }
  for (const lane of [
    'susde_archive',
    'direct_flow',
    'aave_holder',
    'morpho_v2_score',
    'morpho_v2_issue_api',
    'aave_cash',
    'all_subject_cash',
    'apyusd_prospective_intake',
    'apyusd_frozen_open',
    'saturn_pending_series',
  ])
    assert.ok(counts[lane] > 0, `${lane} was starved`)
})

test('real evidence selection probes Aave source despite an unfinished sUSDe archive', async () => {
  let sourceReads = 0
  const readers = {
    archiveReader: async () => ({ summary: { complete: false } }),
    shortStageReader: async () => ({ byLane: [] }),
    h1CashTargetReader: async () => ({ due: false }),
    joinedEndpointReader: async () => {
      sourceReads++
      return 'verified-local-endpoint'
    },
  }
  const evidence = await readCampaignEvidence(2 * SLOT_MS, readers)
  assert.equal(evidence.archiveComplete, false)
  assert.equal(evidence.joinedSourceAvailable, true)
  assert.equal(sourceReads, 1)
  assert.equal(choose(2, evidence), 'aave_holder')
  await readCampaignEvidence(3 * SLOT_MS, readers)
  assert.equal(sourceReads, 1)
})

test('live short-stage scores preempt routine slots before capture closes', () => {
  const shortStage = {
    byLane: [
      { lane: 'fluid_bridge_usdt_score', live: 3, expired: 20 },
      { lane: 'fluid_ftoken_score', live: 2, expired: 46 },
    ],
  }
  const afterSaturn = { saturn_pending_series: 5 * SLOT_MS }
  assert.equal(choose(11, { shortStage, lastAttempts: afterSaturn }), 'fluid_bridge_usdt_score')
  assert.equal(choose(12, { shortStage, lastAttempts: afterSaturn }), 'fluid_bridge_usdt_score')
  assert.equal(choose(5, { shortStage }), 'fluid_bridge_usdt_score')
  assert.equal(
    choose(11, {
      shortStage,
      lastAttempts: { ...afterSaturn, fluid_bridge_usdt_score: 11 * SLOT_MS },
    }),
    'fluid_ftoken_score',
  )
  assert.equal(
    choose(11, {
      shortStage: { byLane: [{ lane: 'not_registered', live: 1, expired: 0 }] },
      lastAttempts: afterSaturn,
    }),
    'morpho_v2_issue_api',
  )
  assert.deepEqual(campaignCommandForLane('fluid_bridge_usdt_score'), [
    '-k',
    '10s',
    '550s',
    '/bin/sh',
    'scripts/carry-fluid-bridge-usdt-holder-tick.sh',
    '--score',
  ])
})

test('native campaign dispatches the Hastra first-stage issue and score wrapper modes', () => {
  assert.deepEqual(campaignCommandForLane('hastra_prime_score'), [
    '-k',
    '10s',
    '550s',
    '/bin/sh',
    'scripts/carry-pyusd-staking-prospective-tick.sh',
    'score-campaign',
  ])
  assert.deepEqual(campaignCommandForLane('hastra_prime_issue'), [
    '-k',
    '10s',
    '550s',
    '/bin/sh',
    'scripts/carry-pyusd-staking-prospective-tick.sh',
    'issue-campaign',
  ])
})

test('the earliest imminent deadline wins while distant live retries still rotate', () => {
  const nowMs = 11 * SLOT_MS
  const shortStage = {
    byLane: [
      {
        lane: 'fluid_bridge_usdt_score',
        live: 1,
        expired: 0,
        nextLiveDeadlineMs: 12 * SLOT_MS,
        nextLiveTargetMs: 9 * SLOT_MS,
      },
      {
        lane: 'fluid_ftoken_score',
        live: 1,
        expired: 0,
        nextLiveDeadlineMs: 12 * SLOT_MS + 60_000,
        nextLiveTargetMs: 10 * SLOT_MS,
      },
    ],
  }
  assert.equal(
    chooseCampaignLane({
      nowMs,
      archiveComplete: true,
      episodeAttested: false,
      joinedSourceAvailable: false,
      shortStage,
      lastAttempts: { fluid_bridge_usdt_score: 10 * SLOT_MS },
    }),
    'fluid_bridge_usdt_score',
  )
  assert.equal(
    chooseCampaignLane({
      nowMs,
      archiveComplete: true,
      episodeAttested: false,
      joinedSourceAvailable: false,
      shortStage: {
        byLane: shortStage.byLane.map((row) => ({
          ...row,
          nextLiveDeadlineMs:
            nowMs + 2 * HOURLY_MS + (row.lane === 'fluid_ftoken_score' ? 60_000 : 0),
          nextLiveTargetMs: 8 * SLOT_MS,
        })),
      },
      lastAttempts: { fluid_bridge_usdt_score: 8 * SLOT_MS },
    }),
    'fluid_ftoken_score',
  )
})

test('a Hastra deadline before the next tick outranks a later untried live lane', () => {
  const nowMs = 30 * SLOT_MS
  assert.equal(
    chooseCampaignLane({
      nowMs,
      archiveComplete: true,
      episodeAttested: false,
      joinedSourceAvailable: false,
      shortStage: {
        byLane: [
          {
            lane: 'hastra_prime_score',
            live: 1,
            expired: 0,
            nextLiveDeadlineMs: nowMs + 570_000,
            nextLiveTargetMs: nowMs - HOURLY_MS,
          },
          {
            lane: 'fluid_bridge_usdt_score',
            live: 1,
            expired: 0,
            nextLiveDeadlineMs: nowMs + 1_080_000,
            nextLiveTargetMs: nowMs - HOURLY_MS,
          },
        ],
      },
      lastAttempts: { hastra_prime_score: nowMs - SLOT_MS },
    }),
    'hastra_prime_score',
  )
})

test('a deadline inside one child runtime outranks an older retry', () => {
  const nowMs = 30 * SLOT_MS
  const shortStage = {
    byLane: [
      {
        lane: 'compound_holder_score',
        live: 1,
        expired: 0,
        nextLiveDeadlineMs: nowMs + 10 * 60_000,
        nextLiveTargetMs: nowMs - 60 * 60_000,
      },
      {
        lane: 'fluid_bridge_usdt_score',
        live: 1,
        expired: 0,
        nextLiveDeadlineMs: nowMs + 60_000,
        nextLiveTargetMs: nowMs - 60 * 60_000,
      },
    ],
  }
  assert.equal(
    chooseCampaignLane({
      nowMs,
      archiveComplete: true,
      episodeAttested: false,
      joinedSourceAvailable: false,
      shortStage,
      lastAttempts: {
        compound_holder_score: nowMs - 30 * 60_000,
        fluid_bridge_usdt_score: nowMs - 10 * 60_000,
      },
    }),
    'fluid_bridge_usdt_score',
  )
  assert.equal(
    chooseCampaignLane({
      nowMs,
      archiveComplete: true,
      episodeAttested: false,
      joinedSourceAvailable: false,
      shortStage: {
        byLane: shortStage.byLane.map((row) =>
          row.lane === 'compound_holder_score'
            ? { ...row, nextLiveDeadlineMs: nowMs + 8 * 60_000 }
            : row,
        ),
      },
      lastAttempts: {
        compound_holder_score: nowMs - 30 * 60_000,
        fluid_bridge_usdt_score: nowMs - 10 * 60_000,
      },
    }),
    'fluid_bridge_usdt_score',
  )
})

test('short-stage evidence is read every full-mode slot', async () => {
  let reads = 0
  const readers = {
    archiveReader: async () => ({ summary: { complete: false } }),
    h1CashTargetReader: async () => ({ due: false }),
    shortStageReader: async () => {
      reads++
      return { byLane: [{ lane: 'fluid_ftoken_score', live: 1, expired: 0 }] }
    },
  }
  const atScore = await readCampaignEvidence(5 * SLOT_MS, readers)
  assert.equal(atScore.shortStage.byLane[0].lane, 'fluid_ftoken_score')
  assert.equal(reads, 1)
  await readCampaignEvidence(4 * SLOT_MS, readers)
  assert.equal(reads, 2)
})

test('linked sGHO fixed-Q issue retries on the next ten-minute tick before its 45-minute deadline', () => {
  const row = {
    lane: 'sgho_fixed_q_issue',
    live: 1,
    expired: 0,
    nextLiveTargetMs: 8 * SLOT_MS,
    nextLiveDeadlineMs: 13 * SLOT_MS,
  }
  assert.equal(
    choose(10, {
      shortStage: { byLane: [row] },
      lastAttempts: { sgho_fixed_q_issue: 9 * SLOT_MS },
    }),
    'sgho_fixed_q_issue',
  )
  assert.equal(
    choose(11, {
      shortStage: { byLane: [row] },
      lastAttempts: { sgho_fixed_q_issue: 10 * SLOT_MS },
    }),
    'sgho_fixed_q_issue',
  )
})

test('short-stage issuance rotates daily only after live score windows clear', () => {
  const quiet = { byLane: [] }
  const lastAttempts = {
    apyusd_prospective_intake: 14 * SLOT_MS,
    apyusd_frozen_open: 14 * SLOT_MS,
  }
  assert.equal(choose(15, { shortStage: quiet, lastAttempts }), 'fluid_bridge_usdc_issue')
  assert.equal(
    choose(15, {
      shortStage: { byLane: [], verificationFailedLanes: ['fluid_bridge_usdc_score'] },
      shortStageVerificationFailed: true,
      lastAttempts,
    }),
    'fluid_bridge_usdt_issue',
  )
  assert.equal(
    choose(15, {
      shortStage: { byLane: [{ lane: 'fluid_bridge_usdt_score', live: 0, expired: 1 }] },
      lastAttempts,
    }),
    'fluid_bridge_usdc_issue',
  )
  assert.equal(
    choose(15, {
      shortStage: { byLane: [{ lane: 'fluid_bridge_usdt_score', live: 0, expired: 1 }] },
      lastAttempts: {
        ...lastAttempts,
        fluid_bridge_usdc_issue: 14 * SLOT_MS,
        fluid_bridge_usdt_issue: 14 * SLOT_MS,
        fluid_ftoken_issue: 14 * SLOT_MS,
        twyne_borrower_pt_issue: 14 * SLOT_MS,
        compound_holder_issue: 14 * SLOT_MS,
        usd3_holder_issue: 14 * SLOT_MS,
        stusds_holder_issue: 14 * SLOT_MS,
        susds_holder_issue: 14 * SLOT_MS,
        spark_usdt_holder_issue: 14 * SLOT_MS,
        umbrella_gho_holder_issue: 14 * SLOT_MS,
        sgho_holder_issue: 14 * SLOT_MS,
        hastra_prime_issue: 14 * SLOT_MS,
      },
    }),
    'fluid_bridge_usdt_score',
  )
  assert.equal(choose(15, { shortStage: { byLane: null }, lastAttempts }), 'susde_archive')
  assert.equal(
    choose(15, {
      shortStage: quiet,
      lastAttempts: { ...lastAttempts, fluid_bridge_usdc_issue: 14 * SLOT_MS },
    }),
    'fluid_bridge_usdt_issue',
  )
  assert.equal(
    choose(15, {
      shortStage: { byLane: [{ lane: 'fluid_ftoken_score', live: 1, expired: 0 }] },
      lastAttempts: { ...lastAttempts, fluid_ftoken_score: 15 * SLOT_MS },
    }),
    'susde_archive',
  )
  assert.deepEqual(campaignCommandForLane('twyne_borrower_pt_issue'), [
    '-k',
    '10s',
    '550s',
    '/bin/sh',
    'scripts/carry-twyne-borrower-pt-tick.sh',
    '--issue',
  ])
  assert.deepEqual(campaignCommandForLane('compound_holder_issue'), [
    '-k',
    '10s',
    '550s',
    '/bin/sh',
    'scripts/carry-local-compound-holder-tick.sh',
    'issue',
  ])
  assert.deepEqual(campaignCommandForLane('compound_holder_score'), [
    '-k',
    '10s',
    '550s',
    '/bin/sh',
    'scripts/carry-local-compound-holder-tick.sh',
    'score',
  ])
  assert.deepEqual(campaignCommandForLane('usd3_holder_issue'), [
    '-k',
    '10s',
    '550s',
    '/bin/sh',
    'scripts/carry-public-usd3-exit-tick.sh',
    'issue',
  ])
  assert.deepEqual(campaignCommandForLane('usd3_holder_score'), [
    '-k',
    '10s',
    '550s',
    '/bin/sh',
    'scripts/carry-public-usd3-exit-tick.sh',
    'score-campaign',
  ])
  for (const [lane, script, mode] of [
    ['stusds_holder_issue', 'scripts/carry-public-stusds-exit-tick.sh', 'issue-campaign'],
    ['stusds_holder_score', 'scripts/carry-public-stusds-exit-tick.sh', 'score-campaign'],
    ['susds_holder_issue', 'scripts/carry-public-susds-exit-tick.sh', 'issue-campaign'],
    ['susds_holder_score', 'scripts/carry-public-susds-exit-tick.sh', 'score-campaign'],
    ['spark_usdt_holder_issue', 'scripts/carry-public-direct-exit-tick.sh', 'issue-spark-campaign'],
    ['spark_usdt_holder_score', 'scripts/carry-public-direct-exit-tick.sh', 'score-spark-campaign'],
    [
      'umbrella_gho_holder_issue',
      'scripts/carry-local-umbrella-gho-holder-tick.sh',
      'issue-campaign',
    ],
    [
      'umbrella_gho_holder_score',
      'scripts/carry-local-umbrella-gho-holder-tick.sh',
      'score-campaign',
    ],
    ['sgho_holder_issue', 'scripts/carry-public-sgho-exit-tick.sh', 'issue-campaign'],
    ['sgho_holder_score', 'scripts/carry-public-sgho-exit-tick.sh', 'score-campaign'],
    ['sgho_fixed_q_issue', 'scripts/carry-public-sgho-exit-tick.sh', 'fixed-q-issue-campaign'],
    ['sgho_fixed_q_score', 'scripts/carry-public-sgho-exit-tick.sh', 'fixed-q-score-campaign'],
  ])
    assert.deepEqual(campaignCommandForLane(lane), ['-k', '10s', '550s', '/bin/sh', script, mode])
})

test('historical expired backlog does not starve new issues or cash collection', () => {
  const shortStage = {
    byLane: [
      {
        lane: 'fluid_bridge_usdt_score',
        live: 0,
        expired: 100,
        nextExpiredDeadlineMs: 2 * SLOT_MS,
      },
    ],
    verificationFailedLanes: [],
  }
  const lastAttempts = {}
  const counts = {}
  for (let slot = 0; slot < 144; slot++) {
    const lane = choose(slot, { shortStage, lastAttempts })
    counts[lane] = (counts[lane] ?? 0) + 1
    lastAttempts[lane] = slot * SLOT_MS
  }
  for (const lane of [
    'fluid_bridge_usdc_issue',
    'fluid_bridge_usdt_issue',
    'fluid_ftoken_issue',
    'twyne_borrower_pt_issue',
    'compound_holder_issue',
    'usd3_holder_issue',
    'stusds_holder_issue',
    'susds_holder_issue',
    'spark_usdt_holder_issue',
    'umbrella_gho_holder_issue',
    'sgho_holder_issue',
    'fluid_bridge_usdt_score',
    'morpho_v2_issue_api',
    'aave_cash',
    'all_subject_cash',
  ])
    assert.ok(counts[lane] > 0, `${lane} was starved by expired targets`)
})

test('slot 5 rotates aggregate cash with API issuance, Aave cash and short-stage issuance for three days', () => {
  const lastAttempts = {}
  const byLane = new Map()
  const shortStage = { byLane: [], verificationFailedLanes: [] }
  for (let slot = 0; slot < 3 * 144; slot++) {
    const lane = choose(slot, { shortStage, lastAttempts })
    if (!byLane.has(lane)) byLane.set(lane, [])
    byLane.get(lane).push(slot)
    lastAttempts[lane] = slot * SLOT_MS
  }
  for (const lane of [
    'all_subject_cash',
    'morpho_v2_issue_api',
    'aave_cash',
    'fluid_bridge_usdc_issue',
    'hastra_prime_issue',
    'direct_flow',
    'aave_holder',
    'morpho_v2_score',
    'apyusd_prospective_intake',
    'apyusd_frozen_open',
    'saturn_pending_series',
  ]) {
    const attempts = byLane.get(lane) ?? []
    assert.ok(attempts.length >= 3, `${lane} was starved`)
    assert.ok(
      attempts.some((slot) => slot < 144),
      `${lane} missed day one`,
    )
    assert.ok(
      attempts.some((slot) => slot >= 288),
      `${lane} missed day three`,
    )
  }
  const cashAttempts = byLane.get('all_subject_cash')
  assert.ok(cashAttempts.length >= 12, 'aggregate cash did not get repeated bounded attempts')
  assert.ok(
    cashAttempts.slice(1).every((slot, index) => slot - cashAttempts[index] <= 72),
    'aggregate cash waited more than twelve hours',
  )
})

test('outside an H1 target window, a sustained live-score backlog preserves deadline priority', () => {
  const lastAttempts = {}
  const liveStage = {
    byLane: ['fluid_bridge_usdc_score', 'fluid_bridge_usdt_score', 'fluid_ftoken_score'].map(
      (lane) => ({
        lane,
        live: 1,
        expired: 0,
        nextLiveTargetMs: 0,
        nextLiveDeadlineMs: 200 * SLOT_MS,
      }),
    ),
    verificationFailedLanes: [],
  }
  const duringBacklog = []
  for (let slot = 0; slot < 144; slot++) {
    const lane = choose(slot, { shortStage: liveStage, lastAttempts })
    duringBacklog.push(lane)
    lastAttempts[lane] = slot * SLOT_MS
  }
  assert.ok(duringBacklog.every((lane) => lane.endsWith('_score')))
  assert.ok(!duringBacklog.includes('all_subject_cash'))

  const recovered = []
  const clearStage = { byLane: [], verificationFailedLanes: [] }
  for (let slot = 144; slot < 288; slot++) {
    const lane = choose(slot, { shortStage: clearStage, lastAttempts })
    recovered.push(lane)
    lastAttempts[lane] = slot * SLOT_MS
  }
  assert.ok(recovered.includes('all_subject_cash'))
})

test('ordinary aggregate-cash rotation never displaces a closing score or enters light mode', () => {
  const nowMs = 23 * SLOT_MS
  const shortStage = {
    byLane: [
      {
        lane: 'fluid_bridge_usdt_score',
        live: 1,
        expired: 0,
        nextLiveTargetMs: nowMs - SLOT_MS,
        nextLiveDeadlineMs: nowMs + SLOT_MS,
      },
    ],
  }
  const lastAttempts = {
    saturn_pending_series: 5 * SLOT_MS,
    morpho_v2_issue_api: 11 * SLOT_MS,
    aave_cash: 17 * SLOT_MS,
  }
  assert.equal(choose(23, { shortStage, lastAttempts }), 'fluid_bridge_usdt_score')
  for (let slot = 0; slot < 3 * 144; slot++) {
    const lane = chooseLightCampaignLane({
      nowMs: slot * SLOT_MS,
      shortStage,
      lastAttempts,
    })
    assert.notEqual(lane, 'all_subject_cash')
  }
})

test('every due first-stage issue lane gets a slot before earlier lanes repeat', () => {
  const lastAttempts = {}
  const seen = new Set()
  for (let slot = 0; slot < 288; slot++) {
    const lane = choose(slot, {
      archiveComplete: true,
      shortStage: { byLane: [] },
      lastAttempts,
    })
    if (lane.endsWith('_issue')) seen.add(lane)
    lastAttempts[lane] = slot * SLOT_MS
  }
  assert.deepEqual([...seen].sort(), [
    'compound_holder_issue',
    'fluid_bridge_usdc_issue',
    'fluid_bridge_usdt_issue',
    'fluid_ftoken_issue',
    'hastra_prime_issue',
    'sgho_holder_issue',
    'spark_usdt_holder_issue',
    'stusds_holder_issue',
    'susds_holder_issue',
    'twyne_borrower_pt_issue',
    'umbrella_gho_holder_issue',
    'usd3_holder_issue',
  ])
})

test('USD3 campaign score bypasses only the obsolete standalone minute deferral', () => {
  const dir = mkdtempSync(join(tmpdir(), 'holder-exit-usd3-wrapper-'))
  const datePath = join(dir, 'date-minute-36.sh')
  writeFileSync(datePath, '#!/bin/sh\nprintf "36\\n"\n', { mode: 0o700 })
  const env = {
    ...process.env,
    TMPDIR: dir,
    PUBLIC_USD3_DATE_BIN: datePath,
    PUBLIC_USD3_NODE_BIN: '/usr/bin/true',
    PUBLIC_USD3_TIMEOUT_BIN: '/usr/bin/true',
  }
  try {
    const deferred = spawnSync('/bin/sh', ['scripts/carry-public-usd3-exit-tick.sh', 'score'], {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
      timeout: 5_000,
    })
    assert.equal(deferred.status, 0, deferred.stderr)
    assert.match(deferred.stdout, /public-usd3-exit:score:deferred/)
    const campaign = spawnSync(
      '/bin/sh',
      ['scripts/carry-public-usd3-exit-tick.sh', 'score-campaign'],
      { cwd: process.cwd(), env, encoding: 'utf8', timeout: 5_000 },
    )
    assert.equal(campaign.status, 0, campaign.stderr)
    assert.match(campaign.stdout, /public-usd3-exit:score:ok/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('USDS vault campaign modes bypass obsolete score minutes and report lock contention', () => {
  for (const [slug, minute] of [
    ['stusds', '36'],
    ['susds', '25'],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), `holder-exit-${slug}-wrapper-`))
    const datePath = join(dir, 'date.sh')
    const timeoutPath = join(dir, 'timeout.sh')
    const argsPath = join(dir, 'timeout-args.txt')
    writeFileSync(datePath, `#!/bin/sh\nprintf '${minute}\\n'\n`, { mode: 0o700 })
    writeFileSync(timeoutPath, '#!/bin/sh\nprintf "%s\\n" "$@" > "$TEST_ARG_CAPTURE"\n', {
      mode: 0o700,
    })
    const prefix = `PUBLIC_${slug.toUpperCase()}`
    const env = {
      ...process.env,
      TMPDIR: dir,
      TEST_ARG_CAPTURE: argsPath,
      [`${prefix}_DATE_BIN`]: datePath,
      [`${prefix}_NODE_BIN`]: '/usr/bin/true',
      [`${prefix}_TIMEOUT_BIN`]: timeoutPath,
    }
    const script = `scripts/carry-public-${slug}-exit-tick.sh`
    try {
      const standalone = spawnSync('/bin/sh', [script, 'score'], {
        cwd: process.cwd(),
        env,
        encoding: 'utf8',
        timeout: 5_000,
      })
      assert.equal(standalone.status, 0, standalone.stderr)
      assert.match(standalone.stdout, /:score:deferred/)
      for (const mode of ['score-campaign', 'issue-campaign']) {
        const campaign = spawnSync('/bin/sh', [script, mode], {
          cwd: process.cwd(),
          env,
          encoding: 'utf8',
          timeout: 5_000,
        })
        assert.equal(campaign.status, 0, campaign.stderr)
        assert.match(campaign.stdout, mode.startsWith('score') ? /:score:ok/ : /:issue:ok/)
        assert.deepEqual(readFileSync(argsPath, 'utf8').split('\n').slice(0, 5), [
          '-k',
          '5s',
          mode.startsWith('score') ? '330s' : '540s',
          '/usr/bin/true',
          '--max-old-space-size=384',
        ])
      }
      const busy = spawnSync(
        '/usr/bin/python3',
        [
          '-c',
          'import fcntl, os, subprocess, sys; fd=os.open(sys.argv[1], os.O_CREAT|os.O_RDWR, 0o600); fcntl.flock(fd, fcntl.LOCK_EX); child=subprocess.run(["/bin/sh", sys.argv[2], "score-campaign"], env=os.environ, capture_output=True, text=True); print(child.stderr.strip()); sys.exit(child.returncode)',
          join(dir, `membrane-public-${slug}-exit.lock`),
          script,
        ],
        { cwd: process.cwd(), env, encoding: 'utf8', timeout: 5_000 },
      )
      assert.equal(busy.status, 75, busy.stderr)
      assert.match(busy.stdout, /:busy/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('Morpho issue and score lanes use the bounded wrapper modes', () => {
  assert.deepEqual(campaignCommandForLane('all_subject_cash'), [
    '-k',
    '10s',
    '550s',
    '/bin/sh',
    'scripts/carry-local-cash-tick.sh',
  ])
  assert.deepEqual(campaignCommandForLane('morpho_v2_score'), [
    '-k',
    '10s',
    '550s',
    '/bin/sh',
    'scripts/carry-local-morpho-holder-tick.sh',
    'v2score',
  ])
  assert.deepEqual(campaignCommandForLane('morpho_v2_issue_api'), [
    '-k',
    '10s',
    '550s',
    '/bin/sh',
    'scripts/carry-local-morpho-holder-tick.sh',
    'issue-missing-api',
  ])
  assert.deepEqual(campaignCommandForLane('apyusd_frozen_open'), [
    '-k',
    '10s',
    '550s',
    '/bin/sh',
    'scripts/carry-apyusd-frozen-open-tick.sh',
  ])
  assert.deepEqual(campaignCommandForLane('apyusd_prospective_intake'), [
    '-k',
    '10s',
    '550s',
    '/bin/sh',
    'scripts/carry-apyusd-prospective-intake-tick.sh',
  ])
  assert.deepEqual(campaignCommandForLane('saturn_pending_series'), [
    '-k',
    '10s',
    '550s',
    '/bin/sh',
    'scripts/carry-saturn-pending-series-tick.sh',
  ])
  assert.throws(() => campaignCommandForLane('unknown'), /campaign_lane_invalid/)
})

test('Saturn campaign wrapper loads TypeScript dependencies in offline verify mode', () => {
  const child = spawnSync('/bin/sh', ['scripts/carry-saturn-pending-series-tick.sh', '--verify'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 15_000,
  })
  assert.equal(child.status, 0, child.stderr)
  const summary = JSON.parse(child.stdout.trim())
  assert.ok(Number.isSafeInteger(summary.samples) && summary.samples >= 0)
  assert.ok(Number.isSafeInteger(summary.lastBlock) && summary.lastBlock > 0)
  assert.ok(Number.isSafeInteger(summary.requestedPriceGated))
  assert.ok(summary.requestedPriceGated >= 0 && summary.requestedPriceGated <= 40)
})

test('bad sUSDe archive keeps independent lanes and an alternating retry slot', () => {
  const failed = { archiveVerificationFailed: true }
  assert.equal(choose(0, failed), 'morpho_v2_score')
  assert.equal(choose(1, failed), 'direct_flow')
  assert.equal(choose(2, failed), 'aave_holder')
  assert.equal(choose(3, failed), 'apyusd_prospective_intake')
  assert.equal(
    choose(9, { ...failed, lastAttempts: { apyusd_prospective_intake: 3 * SLOT_MS } }),
    'apyusd_frozen_open',
  )
  assert.equal(
    choose(15, {
      ...failed,
      lastAttempts: {
        apyusd_prospective_intake: 3 * SLOT_MS,
        apyusd_frozen_open: 9 * SLOT_MS,
      },
    }),
    'susde_archive',
  )
  assert.equal(choose(5, failed), 'saturn_pending_series')
})

test('light disk mode rotates new intake, frozen outcomes and Saturn in slot 3', () => {
  for (const slot of [0, 1, 2, 4, 5])
    assert.equal(chooseLightCampaignLane({ nowMs: slot * SLOT_MS }), null)
  assert.equal(chooseLightCampaignLane({ nowMs: 3 * SLOT_MS }), 'apyusd_prospective_intake')
  assert.equal(
    chooseLightCampaignLane({
      nowMs: 9 * SLOT_MS,
      lastAttempts: { apyusd_prospective_intake: 3 * SLOT_MS },
    }),
    'apyusd_frozen_open',
  )
  assert.equal(
    chooseLightCampaignLane({
      nowMs: 15 * SLOT_MS,
      lastAttempts: {
        apyusd_prospective_intake: 3 * SLOT_MS,
        apyusd_frozen_open: 9 * SLOT_MS,
      },
    }),
    'saturn_pending_series',
  )
  assert.equal(
    chooseLightCampaignLane({
      nowMs: 21 * SLOT_MS,
      lastAttempts: {
        apyusd_prospective_intake: 3 * SLOT_MS,
        apyusd_frozen_open: 9 * SLOT_MS,
        saturn_pending_series: 15 * SLOT_MS,
      },
    }),
    'apyusd_prospective_intake',
  )
})

test('light disk mode scores live deadlines and seals expired targets', () => {
  const live = {
    byLane: [
      {
        lane: 'fluid_bridge_usdt_score',
        live: 1,
        expired: 0,
        nextLiveDeadlineMs: 2 * SLOT_MS,
        nextLiveTargetMs: 0,
      },
    ],
  }
  assert.equal(
    chooseLightCampaignLane({ nowMs: SLOT_MS, shortStage: live }),
    'fluid_bridge_usdt_score',
  )
  const expired = { byLane: [{ lane: 'twyne_borrower_pt_score', live: 0, expired: 1 }] }
  assert.equal(
    chooseLightCampaignLane({ nowMs: 5 * SLOT_MS, shortStage: expired }),
    'twyne_borrower_pt_score',
  )
  assert.equal(
    chooseLightCampaignLane({
      nowMs: 3 * SLOT_MS,
      shortStage: {
        byLane: [
          {
            lane: 'fluid_bridge_usdt_score',
            live: 1,
            expired: 0,
            nextLiveDeadlineMs: 10 * SLOT_MS,
            nextLiveTargetMs: 2 * SLOT_MS,
          },
        ],
      },
    }),
    'apyusd_prospective_intake',
  )
  assert.equal(
    chooseLightCampaignLane({
      nowMs: 3 * SLOT_MS,
      shortStage: {
        byLane: [
          {
            lane: 'fluid_bridge_usdt_score',
            live: 1,
            expired: 0,
            nextLiveDeadlineMs: 4 * SLOT_MS,
            nextLiveTargetMs: 2 * SLOT_MS,
          },
        ],
      },
    }),
    'fluid_bridge_usdt_score',
  )
  assert.equal(
    chooseLightCampaignLane({
      nowMs: 11 * SLOT_MS,
      shortStage: {
        byLane: [
          { lane: 'fluid_bridge_usdt_score', live: 0, expired: 2 },
          { lane: 'twyne_borrower_pt_score', live: 0, expired: 1 },
        ],
      },
      lastAttempts: { fluid_bridge_usdt_score: 5 * SLOT_MS },
    }),
    'twyne_borrower_pt_score',
  )
})

test('light direct issues require both exact-market witnessed 24h flows fresher than two hours', async () => {
  const nowMs = 24 * HOURLY_MS
  const pair = (marketKey, ageMs) => ({
    sources: ['supply', 'withdraw'].map((flowKind) => ({
      marketKey,
      flowKind,
      featureCount: 1,
      reason: null,
    })),
    features: ['supply', 'withdraw'].map((flowKind) => ({
      kind: `gross_supplier_${flowKind}_24h`,
      coverageComplete: true,
      sourceAt: new Date(nowMs - ageMs).toISOString(),
    })),
  })
  assert.equal(
    hasFreshVerifiedDirectFlowPair(pair('aaveV3Usdc', 2 * HOURLY_MS - 1), 'aaveV3Usdc', nowMs),
    true,
  )
  assert.equal(
    hasFreshVerifiedDirectFlowPair(pair('aaveV3Usdc', 2 * HOURLY_MS), 'aaveV3Usdc', nowMs),
    false,
  )
  assert.equal(hasFreshVerifiedDirectFlowPair(pair('aaveV3Usdc', 1), 'aaveV3Usde', nowMs), false)
  const missing = pair('aaveV3Usdc', 1)
  missing.sources.pop()
  assert.equal(hasFreshVerifiedDirectFlowPair(missing, 'aaveV3Usdc', nowMs), false)
  const seen = []
  const lane = await nextFreshLightDirectIssueLane({
    nowMs,
    featureReader: async ({ marketKeys }) => {
      seen.push(marketKeys[0])
      return marketKeys[0] === 'aaveV3Usdc'
        ? pair(marketKeys[0], 2 * HOURLY_MS)
        : pair(marketKeys[0], 1)
    },
  })
  assert.equal(lane, 'aave_usde_holder_issue')
  assert.deepEqual(seen, ['aaveV3Usdc', 'aaveV3Usde'])
  assert.equal(
    chooseLightCampaignLane({
      nowMs: 5 * SLOT_MS,
      shortStage: { byLane: [] },
      directIssueLane: lane,
    }),
    lane,
  )
})

test('light tick rotates all four eligible direct markets and passes final issuer guard', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'holder-exit-direct-light-'))
  const path = join(dir, 'state.json')
  const calls = []
  let clock = 0
  try {
    for (const slot of [5, 11, 17, 23]) {
      clock = 24 * HOURLY_MS + slot * SLOT_MS
      assert.equal(
        await runLightCampaignTick({
          nowMs: clock,
          statePath: path,
          shortStageReader: async () => ({ byLane: [], verificationFailedLanes: [] }),
          directFlowFeatureReader: async ({ marketKeys }) => ({
            sources: ['supply', 'withdraw'].map((flowKind) => ({
              marketKey: marketKeys[0],
              flowKind,
              featureCount: 1,
              reason: null,
            })),
            features: ['supply', 'withdraw'].map((flowKind) => ({
              kind: `gross_supplier_${flowKind}_24h`,
              coverageComplete: true,
              sourceAt: new Date(clock - 1).toISOString(),
            })),
          }),
          spawn: (_command, args, options) => {
            calls.push({ args, env: options.env })
            return { status: 0 }
          },
        }),
        true,
      )
    }
    assert.deepEqual(
      calls.map((call) => call.args.at(-1)),
      ['issue-aave-campaign', 'issue-aave-usde-campaign', 'issue-spark-campaign', 'issue'],
    )
    assert.ok(calls.every((call) => call.env.HOLDER_EXIT_REQUIRE_FRESH_FLOW === '1'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('light tick reserves each prospective, frozen and Saturn attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'holder-exit-light-test-'))
  const path = join(dir, 'state.json')
  const calls = []
  const spawn = (command, args) => {
    calls.push({ command, args })
    return { status: 0, error: null, signal: null }
  }
  const shortStageReader = async () => ({ byLane: [] })
  try {
    assert.equal(
      await runLightCampaignTick({ nowMs: 3 * SLOT_MS, statePath: path, spawn, shortStageReader }),
      true,
    )
    assert.equal(readCampaignState(path).lastAttempts.apyusd_prospective_intake, 3 * SLOT_MS)
    assert.equal(
      await runLightCampaignTick({ nowMs: 9 * SLOT_MS, statePath: path, spawn, shortStageReader }),
      true,
    )
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0].args, campaignCommandForLane('apyusd_prospective_intake'))
    assert.deepEqual(calls[1].args, campaignCommandForLane('apyusd_frozen_open'))
    assert.equal(
      await runLightCampaignTick({ nowMs: 15 * SLOT_MS, statePath: path, spawn, shortStageReader }),
      true,
    )
    assert.equal(calls.length, 3)
    assert.deepEqual(calls[2].args, campaignCommandForLane('saturn_pending_series'))
    assert.equal(
      await runLightCampaignTick({
        nowMs: 16 * SLOT_MS,
        statePath: path,
        spawn,
        shortStageReader: async () => ({
          byLane: [
            {
              lane: 'fluid_bridge_usdt_score',
              live: 1,
              expired: 0,
              nextLiveDeadlineMs: 17 * SLOT_MS,
              nextLiveTargetMs: 15 * SLOT_MS,
            },
          ],
        }),
      }),
      true,
    )
    assert.deepEqual(calls[3].args, campaignCommandForLane('fluid_bridge_usdt_score'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('light ApyUSD tick decodes only reserved stage exits without child output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'holder-exit-apyusd-failure-test-'))
  const writes = []
  const originalWrite = process.stdout.write
  process.stdout.write = (chunk) => {
    writes.push(String(chunk))
    return true
  }
  try {
    for (const [status, stages] of [
      [69, 'receipt_intake,impairment_followup'],
      [2, 'unknown'],
    ]) {
      writes.length = 0
      const ok = await runLightCampaignTick({
        nowMs: 3 * SLOT_MS,
        statePath: join(dir, `state-${status}.json`),
        shortStageReader: async () => ({ byLane: [] }),
        spawn: (_command, args) => {
          assert.deepEqual(args, campaignCommandForLane('apyusd_prospective_intake'))
          return {
            status,
            error: null,
            signal: null,
            stdout: 'child-stdout-secret',
            stderr: 'https://rpc.example/private-token',
          }
        },
      })
      assert.equal(ok, false)
      assert.deepEqual(
        writes.filter((line) => line.startsWith('holder-exit-campaign:')),
        [
          'holder-exit-campaign:apyusd_prospective_intake:failed\n',
          `holder-exit-campaign:apyusd_prospective_intake:failed-stages:${stages}\n`,
        ],
      )
    }
  } finally {
    process.stdout.write = originalWrite
    rmSync(dir, { recursive: true, force: true })
  }
})

test('after archive completion score precedes issue and the assay remains periodic', () => {
  const complete = { archiveComplete: true }
  assert.equal(choose(0, complete), 'morpho_v2_score')
  assert.equal(choose(1, complete), 'direct_flow')
  assert.equal(choose(2, complete), 'aave_holder')
  assert.equal(choose(3, complete), 'apyusd_prospective_intake')
  assert.equal(choose(4, complete), 'morpho_v2_score')
  assert.equal(choose(5, complete), 'saturn_pending_series')
  assert.equal(
    choose(11, { ...complete, lastAttempts: { saturn_pending_series: 5 * SLOT_MS } }),
    'morpho_v2_issue_api',
  )
  assert.equal(
    choose(149, { ...complete, lastAttempts: { saturn_pending_series: 5 * SLOT_MS } }),
    'saturn_pending_series',
  )
  assert.equal(
    choose(9, { ...complete, lastAttempts: { apyusd_prospective_intake: 3 * SLOT_MS } }),
    'apyusd_frozen_open',
  )
  assert.equal(
    choose(15, {
      ...complete,
      lastAttempts: {
        apyusd_prospective_intake: 3 * SLOT_MS,
        apyusd_frozen_open: 9 * SLOT_MS,
      },
    }),
    'susde_assay',
  )
  assert.equal(
    choose(39, {
      ...complete,
      lastAttempts: {
        susde_assay: 3 * SLOT_MS,
        apyusd_prospective_intake: 27 * SLOT_MS,
        apyusd_frozen_open: 33 * SLOT_MS,
      },
    }),
    'susde_assay',
  )
  assert.equal(ASSAY_MS, 36 * SLOT_MS)
  assert.equal(choose(3, { ...complete, episodeAttested: true }), 'apyusd_prospective_intake')
})

test('hourly attempts follow slot boundaries despite launch jitter and clock rollback', () => {
  const complete = { archiveComplete: true }
  assert.equal(choose(7, { ...complete, lastAttempts: { direct_flow: 3 * SLOT_MS } }), 'aave_cash')
  assert.equal(choose(8, { ...complete, lastAttempts: { aave_holder: 8 * SLOT_MS } }), 'aave_cash')
  assert.equal(choose(2, { ...complete, lastAttempts: { aave_holder: 8 * SLOT_MS } }), 'aave_cash')
  assert.equal(
    chooseCampaignLane({
      nowMs: 8 * SLOT_MS + 1,
      ...complete,
      episodeAttested: false,
      joinedSourceAvailable: true,
      lastAttempts: { aave_holder: 3 * SLOT_MS - 1 },
    }),
    'aave_holder',
  )
  assert.equal(
    choose(11, {
      ...complete,
      lastAttempts: {
        morpho_v2_issue_api: 11 * SLOT_MS,
        saturn_pending_series: 5 * SLOT_MS,
      },
    }),
    'aave_cash',
  )
})

test('attempt state is bounded, persistent and recovers from corruption', () => {
  const dir = mkdtempSync(join(tmpdir(), 'holder-exit-campaign-test-'))
  const path = join(dir, 'state.json')
  try {
    const initial = readCampaignState(path)
    assert.deepEqual(initial, { lastAttempts: {} })
    writeCampaignState('aave_holder', SLOT_MS, initial, path)
    const next = readCampaignState(path)
    assert.equal(next.lastAttempts.aave_holder, SLOT_MS)
    writeCampaignState('aave_cash', 2 * SLOT_MS, next, path)
    assert.equal(readCampaignState(path).lastAttempts.aave_cash, 2 * SLOT_MS)
    writeCampaignState('all_subject_cash', 3 * SLOT_MS, readCampaignState(path), path)
    assert.equal(readCampaignState(path).lastAttempts.all_subject_cash, 3 * SLOT_MS)
    writeCampaignState('direct_flow', 6 * SLOT_MS, next, path)
    assert.equal(readCampaignState(path).lastAttempts.direct_flow, 6 * SLOT_MS)
    writeCampaignState('apyusd_frozen_open', 9 * SLOT_MS, readCampaignState(path), path)
    assert.equal(readCampaignState(path).lastAttempts.apyusd_frozen_open, 9 * SLOT_MS)
    writeCampaignState('apyusd_prospective_intake', 10 * SLOT_MS, readCampaignState(path), path)
    assert.equal(readCampaignState(path).lastAttempts.apyusd_prospective_intake, 10 * SLOT_MS)
    writeCampaignState('saturn_pending_series', 11 * SLOT_MS, readCampaignState(path), path)
    assert.equal(readCampaignState(path).lastAttempts.saturn_pending_series, 11 * SLOT_MS)
    writeCampaignState('fluid_ftoken_score', 12 * SLOT_MS, readCampaignState(path), path)
    writeCampaignState('fluid_ftoken_issue', 13 * SLOT_MS, readCampaignState(path), path)
    assert.equal(readCampaignState(path).lastAttempts.fluid_ftoken_score, 12 * SLOT_MS)
    assert.equal(readCampaignState(path).lastAttempts.fluid_ftoken_issue, 13 * SLOT_MS)
    writeFileSync(path, '{broken')
    assert.deepEqual(readCampaignState(path), { lastAttempts: {} })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('low disk exits successfully before launching a child', () => {
  const child = spawnSync('/bin/sh', ['scripts/holder-exit-campaign-tick.sh'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOLDER_EXIT_CAMPAIGN_TEST_MODE: '1',
      HOLDER_EXIT_CAMPAIGN_TEST_FREE_BYTES: '0',
    },
    timeout: 5000,
  })
  assert.equal(child.status, 0)
  assert.match(child.stderr, /holder-exit-campaign:disk-reserve/)
  assert.equal(child.stdout, '')
})
