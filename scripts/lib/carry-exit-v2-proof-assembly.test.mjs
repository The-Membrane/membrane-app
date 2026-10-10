import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CARRY_EXIT_V2_FROZEN_ROUTES } from './carry-exit-v2-rpc-proof.mjs'
import {
  assembleCarryExitV2CallEvidence,
  CarryExitV2ProofAssemblyError,
} from './carry-exit-v2-proof-assembly.mjs'

const route = CARRY_EXIT_V2_FROZEN_ROUTES.find((entry) => entry.kind === 'susds')
const holder = `0x${'1'.repeat(40)}`
const blockHash = `0x${'c'.repeat(64)}`
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`
const addressWord = (address) => address.slice(2).padStart(64, '0')
const rpc = (id, data, result, extras = {}) => ({
  provider: 'test-rpc',
  source: 'test-collector',
  callTarget: route.destination,
  request: {
    jsonrpc: '2.0',
    id,
    method: 'eth_call',
    params: [
      { from: holder, to: route.destination, data },
      { blockHash, requireCanonical: true },
    ],
  },
  response: { jsonrpc: '2.0', id, result },
  ...extras,
})
const reject = (code) => (error) =>
  error instanceof CarryExitV2ProofAssemblyError && error.code === code

function fixture() {
  const frozen = {
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    holder,
    assetsRaw: '1000000',
    blockNumber: '400',
    blockHash,
  }
  const proof = {
    schema: 'carry_exit_v2_proof_v1',
    purpose: 'call',
    chainId: '1',
    ...frozen,
    caller: holder,
    coverageKind: 'shares',
    holderCoverageRaw: '2000000',
    requiredCoverageRaw: '1200000',
    actualConsumedRaw: '1000000',
    simulationStatus: 'success',
    holderCoverageRpc: rpc(1, `0x70a08231${addressWord(holder)}`, word(2000000), {
      decodedRaw: '2000000',
    }),
    requiredCoverageRpc: rpc(2, `0x0a28a477${word(1000000).slice(2)}`, word(1200000), {
      decodedRaw: '1200000',
    }),
    withdrawRpc: rpc(
      3,
      `0xb460af94${word(1000000).slice(2)}${addressWord(holder)}${addressWord(holder)}`,
      word(1000000),
      { decodedAssetsRaw: '1000000', decodedConsumedRaw: '1000000' },
    ),
  }
  const identityEvidence = {
    schema: 'carry_exit_v2_identity_v1',
    provider: 'test-rpc',
    source: 'test-collector',
    chainId: '1',
    blockNumber: '400',
    blockHash,
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    holder,
    kind: 'susds',
    checks: [
      { stage: 'holder_eoa', method: 'eth_getCode', codeBytes: 0, codeSha256: 'test-sha' },
      { stage: 'destination_code', method: 'eth_getCode', codeBytes: 1, codeSha256: 'test-dest' },
      { stage: 'asset_code', method: 'eth_getCode', codeBytes: 1, codeSha256: 'test-asset' },
    ],
  }
  const collector = {
    status: 'raw_rpc_collected',
    provider: 'test-rpc',
    source: 'test-collector',
    blockNumber: '400',
    blockHash,
    routeKind: 'susds',
    identityEvidence,
    proof,
  }
  const replayEvidenceDoc = {
    schema: 'carry_exit_v2_independent_replay_v1',
    blockNumber: '400',
    blockHash,
    origins: { primary: 'https://primary.example', secondary: 'https://secondary.example' },
    headers: {
      primary: {
        before: { target: { number: '0x190', hash: blockHash }, finalized: { number: '0x192' } },
        after: { target: { number: '0x190', hash: blockHash }, finalized: { number: '0x192' } },
      },
      secondary: {
        before: { target: { number: '0x190', hash: blockHash }, finalized: { number: '0x192' } },
        after: { target: { number: '0x190', hash: blockHash }, finalized: { number: '0x192' } },
      },
    },
    responses: {
      primary: {
        holderCoverageRpc: proof.holderCoverageRpc.response,
        requiredCoverageRpc: proof.requiredCoverageRpc.response,
        withdrawRpc: proof.withdrawRpc.response,
      },
      secondary: {
        holderCoverageRpc: proof.holderCoverageRpc.response,
        requiredCoverageRpc: proof.requiredCoverageRpc.response,
        withdrawRpc: proof.withdrawRpc.response,
      },
    },
    identityReplay: {
      primary: [
        { stage: 'holder_eoa', codeBytes: 0, codeSha256: 'test-sha' },
        { stage: 'destination_code', codeBytes: 1, codeSha256: 'test-dest' },
        { stage: 'asset_code', codeBytes: 1, codeSha256: 'test-asset' },
      ],
      secondary: [
        { stage: 'holder_eoa', codeBytes: 0, codeSha256: 'test-sha' },
        { stage: 'destination_code', codeBytes: 1, codeSha256: 'test-dest' },
        { stage: 'asset_code', codeBytes: 1, codeSha256: 'test-asset' },
      ],
    },
    decoded: {
      holderCoverageRaw: '2000000',
      requiredCoverageRaw: '1200000',
      actualConsumedRaw: '1000000',
      simulationStatus: 'success',
      coveredRevert: false,
    },
  }
  const replay = {
    status: 'verified',
    verdict: { simulationStatus: 'success', coveredRevert: false },
    replayEvidenceDoc,
  }
  return { collector, replay, frozen }
}

test('assembles one bounded call document with route, identity, and replay evidence', () => {
  const parts = fixture()
  const doc = assembleCarryExitV2CallEvidence(parts)
  assert.equal(doc.verificationStatus, 'verified')
  assert.equal(doc.routeKey, parts.frozen.routeKey)
  assert.equal(doc.simulationStatus, 'success')
  assert.deepEqual(doc.identityEvidence, parts.collector.identityEvidence)
  assert.deepEqual(doc.replayEvidenceDoc, parts.replay.replayEvidenceDoc)
  assert.equal(doc.actualConsumedRaw, '1000000')
})

test('rejects a changed frozen route, holder, amount, or block', () => {
  for (const [field, value] of [
    ['routeKey', 'other route'],
    ['holder', `0x${'2'.repeat(40)}`],
    ['assetsRaw', '2000000'],
    ['blockHash', `0x${'d'.repeat(64)}`],
  ]) {
    const parts = fixture()
    parts.frozen[field] = value
    assert.throws(() => assembleCarryExitV2CallEvidence(parts), reject('invalid_collected_proof'))
  }
})

test('rejects collector and identity metadata disagreement', () => {
  const parts = fixture()
  parts.collector.identityEvidence.holder = `0x${'2'.repeat(40)}`
  assert.throws(() => assembleCarryExitV2CallEvidence(parts), reject('identity_evidence_mismatch'))
  const other = fixture()
  other.collector.routeKind = 'morpho'
  assert.throws(() => assembleCarryExitV2CallEvidence(other), reject('collector_identity_mismatch'))
})

test('rejects unavailable replay and changed decoded amounts, status, or covered verdict', () => {
  for (const edit of [
    (parts) => (parts.replay.status = 'unavailable'),
    (parts) => (parts.replay.verdict.simulationStatus = 'evm_revert'),
    (parts) => (parts.replay.verdict.coveredRevert = true),
    (parts) => (parts.replay.replayEvidenceDoc.decoded.holderCoverageRaw = '2000001'),
    (parts) => (parts.replay.replayEvidenceDoc.decoded.requiredCoverageRaw = '1200001'),
    (parts) => (parts.replay.replayEvidenceDoc.decoded.actualConsumedRaw = null),
    (parts) => (parts.replay.replayEvidenceDoc.decoded.simulationStatus = 'evm_revert'),
    (parts) => (parts.replay.replayEvidenceDoc.decoded.coveredRevert = true),
  ]) {
    const parts = fixture()
    edit(parts)
    assert.throws(() => assembleCarryExitV2CallEvidence(parts), reject('replay_evidence_mismatch'))
  }
})

test('rejects same or ambiguous origin identities', () => {
  for (const secondary of [
    'https://primary.example',
    'http://primary.example',
    'https://www.primary.example',
  ]) {
    const parts = fixture()
    parts.replay.replayEvidenceDoc.origins.secondary = secondary
    assert.throws(() => assembleCarryExitV2CallEvidence(parts), reject('non_independent_origins'))
  }
})

test('rejects missing replayed identity stages and evidence near the conservative cap', () => {
  const missing = fixture()
  missing.replay.replayEvidenceDoc.identityReplay.secondary = []
  assert.throws(() => assembleCarryExitV2CallEvidence(missing), reject('replay_evidence_mismatch'))
  const huge = fixture()
  huge.replay.replayEvidenceDoc.responses.primary.padding = 'x'.repeat(25 * 1024)
  assert.throws(() => assembleCarryExitV2CallEvidence(huge), reject('evidence_too_large'))
})

test('rejects changed raw replay response and header despite matching self-reported decoded values', () => {
  const badResponse = fixture()
  badResponse.replay.replayEvidenceDoc.responses.secondary.holderCoverageRpc = {
    jsonrpc: '2.0',
    id: 1,
    result: word(1),
  }
  assert.throws(
    () => assembleCarryExitV2CallEvidence(badResponse),
    reject('replay_evidence_mismatch'),
  )
  const badHeader = fixture()
  badHeader.replay.replayEvidenceDoc.headers.primary.after.target.hash = `0x${'d'.repeat(64)}`
  assert.throws(
    () => assembleCarryExitV2CallEvidence(badHeader),
    reject('replay_evidence_mismatch'),
  )
})

test('rejects replayed contract identity disagreement', () => {
  const parts = fixture()
  parts.replay.replayEvidenceDoc.identityReplay.secondary[0].codeSha256 = 'other-sha'
  assert.throws(() => assembleCarryExitV2CallEvidence(parts), reject('replay_evidence_mismatch'))
})
