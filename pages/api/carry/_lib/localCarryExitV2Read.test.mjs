import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  appendLocalCarryExitV2Record,
  CARRY_EXIT_V2_HORIZONS,
  CARRY_EXIT_V2_PREDECESSOR,
  verifyLocalCarryExitV2Ledger,
} from '../../../../scripts/lib/localCarryExitV2Store.mjs'
import { classifySyncVaultScore } from '../../../../scripts/record-carry-sync-vault-exit-v2-scores.mjs'
import { measureCarryExitV2Verified } from '../../../../scripts/lib/carry-exit-v2-verified-measurement.mjs'
import {
  syntheticRoute,
  syntheticVerifiedMeasurementFixture,
} from '../../../../scripts/lib/carry-exit-v2-verified-measurement-fixture.mjs'
import { recordLocalCarryExitV2Readbacks } from '../../../../scripts/lib/localCarryExitV2Witness.mjs'
import {
  LOCAL_CARRY_EXIT_V2_TRUSTED_SOURCE_VALIDATORS,
  readLocalCarryExitV2Evidence,
} from './localCarryExitV2Read.mjs'

const base = Date.parse('2026-10-06T12:00:00.000Z')
const at = (hours = 0) => new Date(base + hours * 3_600_000).toISOString()
const destination = `0x${'1'.repeat(40)}`
const asset = `0x${'2'.repeat(40)}`
const holder = `0x${'9'.repeat(40)}`
const blockHash = `0x${'a'.repeat(64)}`
const identity = {
  routeKey: 'USDC -> exact vault',
  destination,
  asset,
  decimals: 6,
  assetsRaw: '1000000',
  horizonH: 1,
}

const fixture = (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'carry-exit-v2-read-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  return { parent, root: join(parent, 'ledger') }
}

const append = (root, kind, payload, hours) =>
  appendLocalCarryExitV2Record(kind, payload, {
    root,
    now: base + hours * 3_600_000,
    minFreeBytes: 0,
  })

const populate = (root) => {
  const issue = append(
    root,
    'issue',
    {
      issueId: 'private-issue-id',
      routeKey: identity.routeKey,
      destination,
      asset,
      decimals: 6,
      assetsRaw: '1000000',
      baselineStatus: 'success',
      baselineBlock: '100',
      baselineHash: blockHash,
      baselineBlockAtUtc: at(-0.1),
      issuedAtUtc: at(),
      proofEnvelope: {
        schema: 'carry_local_exit_v2_issue_proof_v1',
        holder,
        secret: 'private-baseline-proof',
      },
      issueEnvelope: {
        schema: 'carry_local_exit_v2_issue_envelope_v1',
        authoritativeStore: 'carry_exit_v2_sql',
        source: 'morpho',
      },
      plan: CARRY_EXIT_V2_HORIZONS.map((horizonH) => ({
        horizonH,
        predecessorH: CARRY_EXIT_V2_PREDECESSOR[horizonH],
        conditionalRecovery: false,
        targetAtUtc: at(horizonH),
        deadlineAtUtc: at(horizonH + 2),
      })),
    },
    0,
  )
  append(
    root,
    'readback',
    {
      issueId: 'private-issue-id',
      issueSha256: issue.sha256,
      witnessId: 'private-witness-id',
      readbackAtUtc: at(0.1),
      readbackProof: {
        schema: 'carry_local_exit_v2_readback_proof_v1',
        secret: 'private-readback-proof',
      },
    },
    0.2,
  )
  append(
    root,
    'score',
    {
      issueId: 'private-issue-id',
      horizonH: 1,
      targetAtUtc: at(1),
      deadlineAtUtc: at(3),
      predecessorH: 0,
      predecessorSha256: null,
      status: 'success',
      scoredAtUtc: at(1.5),
      scoreEnvelope: {
        schema: 'carry_local_exit_v2_score_envelope_v1',
        secret: 'private-score-envelope',
      },
      proofEnvelope: {
        schema: 'carry_local_exit_v2_score_proof_v1',
        holder,
        secret: 'private-score-proof',
      },
      targetBlock: '101',
      targetHash: `0x${'b'.repeat(64)}`,
      targetBlockAtUtc: at(1.1),
      observedAtUtc: at(1.2),
    },
    1.5,
  )
}

const ledgerSnapshot = (root) => ({
  head: readFileSync(`${root}.head.json`, 'utf8'),
  files: readdirSync(root)
    .sort()
    .map((name) => [name, readFileSync(join(root, name), 'utf8')]),
})

const trustedFixtureRegistry = [
  {
    id: 'fixture-morpho-score-v1',
    matches: ({ issueRecord, readbackRecord, scoreRecord }) =>
      issueRecord.payload.issueEnvelope.source === 'morpho' &&
      readbackRecord.payload.readbackProof.schema === 'carry_local_exit_v2_readback_proof_v1' &&
      scoreRecord.payload.scoreEnvelope.schema === 'carry_local_exit_v2_score_envelope_v1',
    validate: ({ issueRecord, scoreRecord, plan }) =>
      issueRecord.payload.proofEnvelope.schema === 'carry_local_exit_v2_issue_proof_v1' &&
      scoreRecord.payload.proofEnvelope.schema === 'carry_local_exit_v2_score_proof_v1' &&
      scoreRecord.payload.targetAtUtc === plan.targetAtUtc,
  },
]

test('production registry is fixed and rejects incomplete score proof envelopes', (t) => {
  const { root } = fixture(t)
  populate(root)
  assert(Object.isFrozen(LOCAL_CARRY_EXIT_V2_TRUSTED_SOURCE_VALIDATORS))
  assert.equal(LOCAL_CARRY_EXIT_V2_TRUSTED_SOURCE_VALIDATORS.length, 4)
  const before = ledgerSnapshot(root)
  const result = readLocalCarryExitV2Evidence(
    { ...identity, validatorId: 'request-evil', measurementValidator: () => true },
    {
      root,
      now: at(2),
      validatorId: 'request-evil',
      measurementValidator: () => true,
    },
  )
  assert.deepEqual(ledgerSnapshot(root), before)
  assert.equal(result.status, 'collecting')
  assert.equal(result.measurementValidatorId, 'carry-exit-v2-local-sealed-evidence-consistency-v1')
  assert.equal(result.evidence.issued, 1)
  assert.equal(result.evidence.recordedUnverified, 1)
  assert.equal(result.evidence.measured, 0)
  assert.equal(result.evidence.latest.status, 'recorded_unverified')
})

test('production validator counts a complete exact-Q proof as locally measured', async (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'carry-exit-v2-read-measured-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const root = join(parent, 'ledger')
  const measuredHolder = `0x${'1'.repeat(40)}`
  const measuredIdentity = {
    routeKey: syntheticRoute.routeKey,
    destination: syntheticRoute.destination,
    asset: syntheticRoute.asset,
    decimals: 6,
    assetsRaw: '1000000',
    horizonH: 1,
  }
  const issueId = 'local:sync:test:production-validator'
  const issuedAtUtc = at(0)
  const targetAtUtc = at(1)
  const deadlineAtUtc = at(3)
  const baselineHash = `0x${'a'.repeat(64)}`
  const issue = append(
    root,
    'issue',
    {
      issueId,
      ...measuredIdentity,
      baselineStatus: 'success',
      baselineBlock: '300',
      baselineHash,
      baselineBlockAtUtc: at(-1 / 60),
      issuedAtUtc,
      proofEnvelope: { schema: 'carry_local_exit_v2_no_neon_proof_v1' },
      issueEnvelope: {
        schema: 'carry_local_exit_v2_no_neon_issue_v1',
        authoritativeStore: 'local_carry_exit_v2',
        source: 'sync_vault',
        authority: { clock: 'local_operator_clock', issuedAtUtc },
        sourcePlan: {
          holder: measuredHolder,
          routeKey: measuredIdentity.routeKey,
          destination: measuredIdentity.destination,
          asset: measuredIdentity.asset,
          assetDecimals: measuredIdentity.decimals,
          baselineBlock: '300',
          baselineHash,
          baselineBlockAtUtc: at(-1 / 60),
        },
      },
      plan: CARRY_EXIT_V2_HORIZONS.map((horizonH) => ({
        horizonH,
        predecessorH: CARRY_EXIT_V2_PREDECESSOR[horizonH],
        conditionalRecovery: false,
        targetAtUtc: at(horizonH),
        deadlineAtUtc: at(horizonH + 2),
      })),
    },
    0,
  )
  recordLocalCarryExitV2Readbacks({ root, now: () => new Date(at(1 / 12)), minFreeBytes: 0 })

  const fixture = syntheticVerifiedMeasurementFixture()
  fixture.input.source = 'carry_local_exit_v2_sync_vault_score'
  const target = structuredClone(fixture.input.target)
  target.targetBlockAt = new Date(Date.parse(targetAtUtc) + 12_000).toISOString()
  target.targetParentBlockAt = new Date(Date.parse(targetAtUtc) - 12_000).toISOString()
  target.targetObservedAt = new Date(Date.parse(target.targetBlockAt) + 3_000).toISOString()
  target.canonicalityEvidenceDoc.targetAt = targetAtUtc
  target.canonicalityEvidenceDoc.observedAt = target.targetObservedAt
  target.canonicalityEvidenceDoc.targetHeader.timestamp = target.targetBlockAt
  target.canonicalityEvidenceDoc.parentHeader.timestamp = target.targetParentBlockAt
  target.canonicalityEvidenceDoc.baselineHeader = {
    number: '300',
    hash: baselineHash,
    parentHash: `0x${'9'.repeat(64)}`,
    timestamp: at(-1 / 60),
  }
  fixture.input.target = target
  fixture.input.now = () => new Date(Date.parse(target.targetObservedAt) + 1_000)
  const verified = await measureCarryExitV2Verified(fixture.input)
  assert.equal(verified.status, 'verified')
  const capturedAtUtc = new Date(Date.parse(target.targetObservedAt) + 5_000).toISOString()
  const row = {
    routeKey: measuredIdentity.routeKey,
    destination: measuredIdentity.destination,
    asset: measuredIdentity.asset,
    holder: measuredHolder,
    assetsRaw: measuredIdentity.assetsRaw,
  }
  const classification = classifySyncVaultScore({
    core: {
      issueId,
      horizonH: 1,
      targetAt: targetAtUtc,
      deadlineAt: deadlineAtUtc,
      predecessorH: 0,
    },
    target,
    verified,
    row,
    capturedAt: capturedAtUtc,
  })
  const summary = Object.fromEntries(
    [
      'status',
      'coverageKind',
      'holderCoverageRaw',
      'requiredCoverageRaw',
      'actualConsumedRaw',
      'simulationStatus',
      'entitlementMethod',
      'inconclusiveReason',
    ].map((field) => [field, classification[field] ?? null]),
  )
  const readback = verifyLocalCarryExitV2Ledger({ root }).readbacks.get(issueId)
  append(
    root,
    'score',
    {
      issueId,
      horizonH: 1,
      targetAtUtc,
      deadlineAtUtc,
      predecessorH: 0,
      predecessorSha256: null,
      status: classification.status,
      scoredAtUtc: new Date(Date.parse(capturedAtUtc) + 5_000).toISOString(),
      targetBlock: target.targetBlock,
      targetHash: target.targetHash,
      targetBlockAtUtc: target.targetBlockAt,
      observedAtUtc: target.targetObservedAt,
      scoreEnvelope: {
        schema: 'carry_local_exit_v2_score_envelope_v1',
        source: 'sync_vault',
        classifierId: 'carry_local_exit_v2_sync_vault_classifier_v1',
        issueSha256: issue.sha256,
        readbackSha256: readback.sha256,
        holder: measuredHolder,
        assetsRaw: measuredIdentity.assetsRaw,
        classifiedAtUtc: capturedAtUtc,
        classification: summary,
        minedPayoutProven: false,
        prospectiveValidated: false,
        forecastValidated: false,
        holderExecutableExit: false,
      },
      proofEnvelope: {
        schema: 'carry_local_exit_v2_score_proof_v1',
        targetEvidence: target,
        callEvidenceDoc: verified.callEvidenceDoc,
        independentTimestamp: false,
        localLedgerWitnessOnly: true,
      },
    },
    (Date.parse(new Date(Date.parse(capturedAtUtc) + 5_000).toISOString()) - base) / 3_600_000,
  )

  const state = verifyLocalCarryExitV2Ledger({ root })
  const scoreRecord = state.outcomes.get(`${issueId}\u001f1`)
  const readbackRecord = state.readbacks.get(issueId)
  const plan = issue.payload.plan.find((entry) => entry.horizonH === 1)
  const validator = LOCAL_CARRY_EXIT_V2_TRUSTED_SOURCE_VALIDATORS.find(
    (entry) => entry.id === 'local_sync_vault_sealed_evidence_v1',
  )
  const input = { issueRecord: issue, readbackRecord, scoreRecord, plan }
  assert.equal(validator.matches(input), true)
  assert.equal(validator.validate(input), true)
  for (const mutate of [
    (copy) => {
      copy.scoreRecord.payload.proofEnvelope.callEvidenceDoc.replayEvidenceDoc.responses.secondary =
        {}
    },
    (copy) => {
      copy.scoreRecord.payload.proofEnvelope.callEvidenceDoc.replayEvidenceDoc.headers.secondary.after.target.hash =
        blockHash
    },
    (copy) => {
      copy.scoreRecord.payload.proofEnvelope.callEvidenceDoc.replayEvidenceDoc.identityReplay.secondary[0].codeSha256 =
        'f'.repeat(64)
    },
    (copy) => {
      copy.scoreRecord.payload.proofEnvelope.callEvidenceDoc.replayEvidenceDoc.decoded.actualConsumedRaw =
        '1'
    },
    (copy) => {
      copy.scoreRecord.payload.proofEnvelope.callEvidenceDoc.identityEvidence = null
    },
    (copy) => {
      copy.scoreRecord.payload.proofEnvelope.callEvidenceDoc.withdrawRpc.response.result = '0x'
    },
    (copy) => {
      copy.scoreRecord.payload.scoreEnvelope.classifiedAtUtc = at(100)
    },
    (copy) => {
      copy.scoreRecord.payload.scoreEnvelope.classifiedAtUtc = 'invalid'
    },
    (copy) => {
      copy.scoreRecord.payload.scoreEnvelope.classifiedAtUtc = 17
    },
    (copy) => {
      copy.scoreRecord.payload.scoreEnvelope.classifiedAtUtc = []
    },
    (copy) => {
      copy.scoreRecord.payload.scoreEnvelope.classifiedAtUtc = {}
    },
    (copy) => {
      copy.scoreRecord.payload.scoreEnvelope.classifiedAtUtc = '2026-10-06T08:00:20-04:00'
    },
    (copy) => {
      const evidence = copy.scoreRecord.payload.proofEnvelope.callEvidenceDoc.identityEvidence
      evidence.checks.length = 3
      copy.scoreRecord.payload.proofEnvelope.callEvidenceDoc.replayEvidenceDoc.identityReplay.primary.length = 3
      copy.scoreRecord.payload.proofEnvelope.callEvidenceDoc.replayEvidenceDoc.identityReplay.secondary.length = 3
    },
    (copy) => {
      copy.scoreRecord.payload.proofEnvelope.callEvidenceDoc.identityEvidence.checks[0].request.params[0] =
        measuredIdentity.destination
    },
    (copy) => {
      const call = copy.scoreRecord.payload.proofEnvelope.callEvidenceDoc
      const check = call.identityEvidence.checks.find((row) => row.stage === 'vault_asset')
      const wrongAsset = `0x${'f'.repeat(40)}`
      check.response.result = `0x${'0'.repeat(24)}${wrongAsset.slice(2)}`
      check.decodedAddress = wrongAsset
      for (const origin of ['primary', 'secondary']) {
        const summary = call.replayEvidenceDoc.identityReplay[origin].find(
          (row) => row.stage === 'vault_asset',
        )
        summary.response = structuredClone(check.response)
        summary.decodedAddress = wrongAsset
      }
    },
  ]) {
    const tampered = structuredClone(input)
    mutate(tampered)
    assert.equal(validator.validate(tampered), false)
  }

  const result = readLocalCarryExitV2Evidence(measuredIdentity, { root, now: at(2) })
  assert.equal(result.evidence.measured, 1)
  assert.equal(result.evidence.recordedUnverified, 0)
  assert.equal(result.measurementValidatorId, 'carry-exit-v2-local-sealed-evidence-consistency-v1')
  assert.equal(result.provenance, 'local_operator_clock')
  assert.equal(result.independentWitness, false)
  assert.equal(result.independentTimestamp, false)
  assert.equal(result.prospectiveValidated, false)
  assert.equal(result.forecastValidated, false)
  assert.equal(result.holderExecutableExit, false)
})

test('an injected trusted registry validates evidence without exposing private records', (t) => {
  const { root } = fixture(t)
  populate(root)
  const result = readLocalCarryExitV2Evidence(identity, {
    root,
    now: at(2),
    validatorRegistry: trustedFixtureRegistry,
  })
  assert.equal(result.status, 'collecting')
  assert.equal(result.evidence.measured, 1)
  assert.equal(result.evidence.recordedUnverified, 0)
  assert.equal(result.evidence.localReadbacks, 1)
  assert.deepEqual(result.evidence.latest, {
    targetAtUtc: at(1),
    deadlineAtUtc: at(3),
    status: 'measured',
    due: true,
    localReadback: true,
  })
  for (const flag of [
    'independentTimestamp',
    'independentWitness',
    'externalMonotonicCheckpoint',
    'rollbackProof',
    'minedPayoutProven',
    'prospectiveValidated',
    'forecastValidated',
    'holderExecutableExit',
    'calibratedForecast',
  ])
    assert.equal(result[flag], false)
  const publicJson = JSON.stringify(result)
  for (const secret of [
    'private-issue-id',
    'private-witness-id',
    holder,
    'private-baseline-proof',
    'private-readback-proof',
    'private-score-envelope',
    'private-score-proof',
  ])
    assert(!publicJson.includes(secret))
  for (const privateKey of [
    'issueId',
    'witnessId',
    'proofEnvelope',
    'readbackProof',
    'scoreEnvelope',
  ])
    assert(!publicJson.includes(`\"${privateKey}\"`))
})

test('selection is exact across subject fields and horizon', (t) => {
  const { root } = fixture(t)
  populate(root)
  const differences = [
    { routeKey: 'USDC -> another vault' },
    { destination: `0x${'3'.repeat(40)}` },
    { asset: `0x${'4'.repeat(40)}` },
    { decimals: 18 },
    { assetsRaw: '1000001' },
  ]
  for (const difference of differences) {
    const result = readLocalCarryExitV2Evidence(
      { ...identity, ...difference },
      { root, now: at(2) },
    )
    assert.equal(result.status, 'unavailable')
    assert.equal(result.reason, 'no_exact_subject')
    assert.equal(result.evidence, null)
  }
  const h4 = readLocalCarryExitV2Evidence({ ...identity, horizonH: 4 }, { root, now: at(2) })
  assert.equal(h4.status, 'collecting')
  assert.equal(h4.horizonH, 4)
  assert.equal(h4.evidence.pending, 1)
  assert.equal(h4.evidence.due, 0)
})

test('invalid input, corrupt ledgers, and invalid or failing registries return typed unavailable', (t) => {
  const { root } = fixture(t)
  populate(root)
  const invalid = readLocalCarryExitV2Evidence({ ...identity, assetsRaw: '01' }, { root })
  assert.equal(invalid.status, 'unavailable')
  assert.equal(invalid.reason, 'invalid_exact_identity')
  assert.equal(invalid.holderExecutableExit, false)
  assert.equal(invalid.evidence, null)
  assert.equal(
    readLocalCarryExitV2Evidence(identity, { root, now: Symbol('clock') }).reason,
    'invalid_clock',
  )

  const badRegistry = readLocalCarryExitV2Evidence(identity, {
    root,
    validatorRegistry: [
      { id: 'duplicate', matches: () => true, validate: () => true },
      { id: 'duplicate', matches: () => true, validate: () => true },
    ],
  })
  assert.equal(badRegistry.reason, 'trusted_validator_registry_invalid')

  const getterRegistry = []
  Object.defineProperty(getterRegistry, '0', {
    enumerable: true,
    get() {
      throw new Error('private registry getter')
    },
  })
  getterRegistry.length = 1
  assert.equal(
    readLocalCarryExitV2Evidence(identity, { root, validatorRegistry: getterRegistry }).reason,
    'trusted_validator_registry_invalid',
  )

  const throwing = readLocalCarryExitV2Evidence(identity, {
    root,
    validatorRegistry: [
      {
        id: 'throws',
        matches: () => {
          throw new Error('private failure')
        },
        validate: () => true,
      },
    ],
  })
  assert.equal(throwing.reason, 'trusted_projection_failed')
  assert(!JSON.stringify(throwing).includes('private failure'))

  const state = verifyLocalCarryExitV2Ledger({ root })
  writeFileSync(
    `${root}.head.json`,
    `${JSON.stringify({ sequence: 999, lastSha256: state.records.at(-1).sha256 })}\n`,
  )
  const corrupted = readLocalCarryExitV2Evidence(identity, { root })
  assert.equal(corrupted.status, 'unavailable')
  assert.equal(corrupted.reason, 'ledger_verification_failed')
  assert.equal(corrupted.evidence, null)
  assert.equal(corrupted.measurementValidatorId, null)
  assert.match(corrupted.chainLimitation, /no external monotonic checkpoint or rollback proof/)
})
