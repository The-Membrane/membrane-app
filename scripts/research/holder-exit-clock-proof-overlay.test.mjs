import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { applyHolderExitClockProofOverlay } from './holder-exit-clock-proof-overlay.mjs'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const routeKey = 'USDC → VaultV2 [USDC]'
const destination = `0x${'1'.repeat(40)}`
const asset = `0x${'2'.repeat(40)}`
const subject = `${routeKey}\0${destination}\0${asset}`
const stageScope = 'direct_morpho_vaultv2_withdraw_eth_call'
const targetAtUtc = '2026-10-04T01:00:00.000Z'
const deadlineAtUtc = '2026-10-04T02:00:00.000Z'

function sealed(body) {
  return { ...body, sha256: sha(JSON.stringify(body)) }
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'clock-overlay-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const issue = sealed({
    routeKey,
    destination,
    asset,
    issuedAtUtc: '2026-10-04T00:10:00.000Z',
    targets: [{ targetAtUtc }],
  })
  const score = sealed({
    routeKey,
    destination,
    asset,
    issueSha256: issue.sha256,
    targetAtUtc,
    scoredAtUtc: '2026-10-04T01:05:00.000Z',
  })
  const issuePath = join(dir, 'issue.json')
  const scorePath = join(dir, 'score.json')
  await writeFile(issuePath, `${JSON.stringify(issue)}\n`)
  await writeFile(scorePath, `${JSON.stringify(score)}\n`)
  const row = {
    subject,
    stageScope,
    targetAtUtc,
    deadlineAtUtc,
    observedAtUtc: '2026-10-04T01:03:00.000Z',
    issueAtUtc: issue.issuedAtUtc,
    labelAvailableAtUtc: score.scoredAtUtc,
    issueSha256: issue.sha256,
    scoreSha256: score.sha256,
    issueClock: 'local_operator_clock_unwitnessed',
    featureAvailabilityClock: 'local_operator_clock_unwitnessed',
  }
  const panel = { subjects: [{ episodes: [row] }], forecastValidated: false }
  const descriptor = (kind, overrides = {}) => ({
    kind,
    artifactPath: kind === 'issue' ? issuePath : scorePath,
    recordSha256: kind === 'issue' ? issue.sha256 : score.sha256,
    subject,
    stageScope,
    targetAtUtc,
    expectedPolicyOid: '1.3.6.1.4.1.57264.2',
    rootPem: 'supplied root',
    chainPem: 'supplied chain',
    expectedRootSha256: sha('supplied root'),
    ...overrides,
  })
  const replay = async (proof) => ({
    status: 'verified_under_supplied_pin',
    artifactSha256: sha(await readFile(proof.artifactPath)),
    rootSha256: proof.expectedRootSha256,
    policyOid: proof.expectedPolicyOid,
    intervalUtc:
      proof.kind === 'issue'
        ? {
            earliest: '2026-10-04T00:19:59.000Z',
            latest: '2026-10-04T00:20:01.000Z',
          }
        : {
            earliest: '2026-10-04T01:05:59.000Z',
            latest: '2026-10-04T01:06:01.000Z',
          },
  })
  return { panel, issuePath, scorePath, descriptor, replay }
}

const rowOf = (panel) => panel.subjects[0].episodes[0]
const run = (fixture, proofs, replay = fixture.replay) =>
  applyHolderExitClockProofOverlay(fixture.panel, proofs, {
    replay,
    nowMs: Date.parse('2026-10-04T03:00:00.000Z'),
  })

test('exact verified issue and score bytes add conservative availability without rewriting local clocks', async (t) => {
  const f = await fixture(t)
  const panel = await run(f, [f.descriptor('issue'), f.descriptor('score')])
  const row = rowOf(panel)
  assert.equal(row.issueAtUtc, '2026-10-04T00:10:00.000Z')
  assert.equal(row.labelAvailableAtUtc, '2026-10-04T01:05:00.000Z')
  assert.equal(row.issueClock, 'rfc3161_verified_under_supplied_pin')
  assert.equal(row.scoreClock, 'rfc3161_verified_under_supplied_pin')
  assert.equal(row.issueWitnessedAvailabilityAtUtc, '2026-10-04T00:20:01.000Z')
  assert.equal(row.scoreWitnessedAvailabilityAtUtc, '2026-10-04T01:06:01.000Z')
  assert.equal(row.featureAvailabilityClock, 'local_operator_clock_unwitnessed')
  assert.equal(row.issueClockProof.rootProvenance, 'caller_supplied_unverified')
  assert.equal(panel.clockProofOverlay.independentUtcWitnesses, 0)
  assert.equal(panel.forecastValidated, false)
  assert.equal(f.panel.subjects[0].episodes[0].scoreClock, undefined)
})

test('missing, duplicate, mismatched and rejected proofs leave clocks unwitnessed', async (t) => {
  const f = await fixture(t)
  assert.equal(rowOf(await run(f, [])).issueClock, 'local_operator_clock_unwitnessed')
  const duplicate = await run(f, [
    f.descriptor('issue'),
    f.descriptor('issue'),
    f.descriptor('issue'),
  ])
  assert.equal(rowOf(duplicate).issueClock, 'local_operator_clock_unwitnessed')
  assert.equal(duplicate.clockProofOverlay.duplicateKeys, 1)
  assert.equal(
    rowOf(await run(f, [f.descriptor('issue', { stageScope: 'different_stage' })])).issueClock,
    'local_operator_clock_unwitnessed',
  )
  assert.equal(
    rowOf(await run(f, [f.descriptor('issue', { recordSha256: sha('wrong') })])).issueClock,
    'local_operator_clock_unwitnessed',
  )
  assert.equal(
    rowOf(await run(f, [f.descriptor('issue')], async () => ({ status: 'unverified' }))).issueClock,
    'local_operator_clock_unwitnessed',
  )
  const wrongRoot = async (proof) => ({
    ...(await f.replay(proof)),
    rootSha256: sha('different root'),
  })
  assert.equal(
    rowOf(await run(f, [f.descriptor('issue')], wrongRoot)).issueClock,
    'local_operator_clock_unwitnessed',
  )
  const wrongPolicy = async (proof) => ({
    ...(await f.replay(proof)),
    policyOid: '1.2.3.4',
  })
  assert.equal(
    rowOf(await run(f, [f.descriptor('issue')], wrongPolicy)).issueClock,
    'local_operator_clock_unwitnessed',
  )
})

test('a token returned for bytes changed before binding cannot promote a clock', async (t) => {
  const f = await fixture(t)
  const originalSha = sha(await readFile(f.issuePath))
  const replay = async (proof) => {
    await writeFile(proof.artifactPath, 'changed\n')
    return {
      status: 'verified_under_supplied_pin',
      artifactSha256: originalSha,
      intervalUtc: {
        earliest: '2026-10-04T00:19:59.000Z',
        latest: '2026-10-04T00:20:01.000Z',
      },
    }
  }
  assert.equal(
    rowOf(await run(f, [f.descriptor('issue')], replay)).issueClock,
    'local_operator_clock_unwitnessed',
  )
})

test('proof after target or score deadline abstains even when token replay succeeds', async (t) => {
  const f = await fixture(t)
  const late = async (proof) => ({
    ...(await f.replay(proof)),
    intervalUtc:
      proof.kind === 'issue'
        ? {
            earliest: '2026-10-04T01:00:00.000Z',
            latest: '2026-10-04T01:00:01.000Z',
          }
        : {
            earliest: '2026-10-04T02:00:00.000Z',
            latest: '2026-10-04T02:00:01.000Z',
          },
  })
  const row = rowOf(await run(f, [f.descriptor('issue'), f.descriptor('score')], late))
  assert.equal(row.issueClock, 'local_operator_clock_unwitnessed')
  assert.equal(row.scoreClock, 'local_operator_clock_unwitnessed')
  assert.equal(row.issueWitnessedAvailabilityAtUtc, undefined)
  assert.equal(row.scoreWitnessedAvailabilityAtUtc, undefined)
})

test('proof intervals wholly before local issue or score availability abstain as clock conflicts', async (t) => {
  const f = await fixture(t)
  const contradictory = async (proof) => ({
    ...(await f.replay(proof)),
    intervalUtc:
      proof.kind === 'issue'
        ? {
            earliest: '2026-10-04T00:04:59.000Z',
            latest: '2026-10-04T00:05:01.000Z',
          }
        : {
            earliest: '2026-10-04T01:03:01.000Z',
            latest: '2026-10-04T01:04:59.000Z',
          },
  })
  const row = rowOf(await run(f, [f.descriptor('issue'), f.descriptor('score')], contradictory))
  assert.equal(row.issueClock, 'local_operator_clock_unwitnessed')
  assert.equal(row.scoreClock, 'local_operator_clock_unwitnessed')
})
