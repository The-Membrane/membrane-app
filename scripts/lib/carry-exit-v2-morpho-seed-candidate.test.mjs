import assert from 'node:assert/strict'
import test from 'node:test'

import {
  discoverMorphoSeedIssuerCandidate,
  readMorphoSeedCandidates,
  validateMorphoSeedCandidateEvidence,
} from './carry-exit-v2-morpho-seed-candidate.mjs'
import { BOARD_ROUTES } from '../research/carry-local-morpho-holder-v2.mjs'

const route = BOARD_ROUTES[35]
const hash = `0x${'a'.repeat(64)}`
const parent = `0x${'b'.repeat(64)}`
const w = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`
const baseline = {
  ...route,
  targetBlock: '1000',
  targetHash: hash,
  targetParentHash: parent,
  totalAssetsRaw: '1000000',
  assetDecimals: 6,
  canonicalityEvidenceDoc: {
    schema: 'carry_exit_v2_headers_v1',
    targetHeader: { hash, number: '1000' },
  },
}
const { owners } = readMorphoSeedCandidates()
function rpc({
  eligible = owners[0],
  shares = 100n,
  claim = 90n,
  code = '0x',
  blockHash = hash,
} = {}) {
  return async (method, params) => {
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getBlockByNumber') return { hash: blockHash, parentHash: parent }
    if (method === 'eth_getCode') {
      assert.deepEqual(params[1], { blockHash: hash, requireCanonical: true })
      return params[0] === route.destination ? '0x1234' : params[0] === eligible ? code : '0x'
    }
    if (method === 'eth_call') {
      assert.deepEqual(params[1], { blockHash: hash, requireCanonical: true })
      const selector = params[0].data.slice(0, 10)
      if (selector === '0x38d52e0f') return w(BigInt(route.asset))
      if (selector === '0x01e1d114') return w(1000000)
      if (selector === '0x70a08231')
        return w(params[0].data.endsWith(eligible.slice(2)) ? shares : 0n)
      if (selector === '0x4cdad506') return w(claim)
    }
    throw Error('unexpected_rpc')
  }
}
const peers = (first = {}, second = {}) => ({
  primary: { provider: 'https://one.example/rpc', request: rpc(first) },
  secondary: { provider: 'https://two.example/rpc', request: rpc(second) },
})
const discover = (first = {}, second = {}) =>
  discoverMorphoSeedIssuerCandidate({ baseline, ...peers(first, second) })
const verify = (doc) =>
  validateMorphoSeedCandidateEvidence(doc, {
    primaryProvider: 'https://one.example/rpc',
    secondaryProvider: 'https://two.example/rpc',
  })

test('physical frozen seed has exactly nine route-specific owner hints', () => {
  assert.equal(owners.length, 9)
  assert.equal(new Set(owners).size, 9)
  assert.throws(
    () => readMorphoSeedCandidates(() => Buffer.from('{}')),
    /morpho_seed_integrity_invalid/,
  )
})

test('seed hint needs two agreeing pinned EOA shares and claim before selection', async () => {
  const candidate = await discover()
  assert.equal(candidate.holder, owners[0])
  assert.equal(candidate.evidenceDoc.selectedSharesRaw, '100')
  assert.equal(candidate.evidenceDoc.selectedClaimRaw, '90')
  assert.equal(candidate.evidenceDoc.ladder.selectedClaimRaw, '90')
  assert.equal(candidate.evidenceDoc.discovery.exhaustiveHolderSearch, false)
  assert.equal(candidate.evidenceDoc.discovery.historicalHolderProof, false)
  assert.equal(JSON.stringify(candidate.evidenceDoc).includes(owners[0]), false)
  assert.equal(verify(candidate.evidenceDoc), candidate.evidenceDoc)
})

test('wrong route, vault, or same RPC host fails before candidate selection', async () => {
  for (const wrong of [BOARD_ROUTES[7], BOARD_ROUTES[34]])
    await assert.rejects(
      () =>
        discoverMorphoSeedIssuerCandidate({
          baseline: { ...baseline, ...wrong },
          ...peers(),
        }),
      /morpho_seed_input_invalid/,
    )
  await assert.rejects(
    () =>
      discoverMorphoSeedIssuerCandidate({
        baseline,
        primary: peers().primary,
        secondary: { provider: 'https://one.example/other', request: rpc() },
      }),
    /morpho_seed_input_invalid/,
  )
})

test('contract holder, zero shares, and host disagreement produce no holder', async () => {
  for (const [first, second] of [
    [{ code: '0x1234' }, { code: '0x1234' }],
    [{ shares: 0n }, { shares: 0n }],
    [{ shares: 100n }, { shares: 101n }],
    [{ blockHash: parent }, {}],
  ]) {
    const candidate = await discover(first, second)
    assert.equal(candidate.holder, null)
    assert.equal(candidate.evidenceDoc.selectedClaimRaw, null)
    assert.equal(verify(candidate.evidenceDoc), candidate.evidenceDoc)
  }
})

test('offline verifier rejects substituted provenance, seed, Q, or selected holder', async () => {
  const doc = (await discover()).evidenceDoc
  for (const mutate of [
    (row) => {
      row.discovery.source = 'morpho-api'
    },
    (row) => {
      row.discovery.source = 'transfer-logs'
    },
    (row) => {
      row.discovery.seedSha256 = '0'.repeat(64)
    },
    (row) => {
      row.discovery.candidateCommitments[0] = '0'.repeat(64)
    },
    (row) => {
      row.selectedHolderCommitment = '0'.repeat(64)
    },
    (row) => {
      row.ladder.selectedClaimRaw = '999'
    },
    (row) => {
      row.screenedCandidates[0].pinnedProof.first.claimRaw = '999'
    },
    (row) => {
      row.screenedCandidates[0].seedRank = 8
    },
  ]) {
    const forged = structuredClone(doc)
    mutate(forged)
    assert.throws(() => verify(forged), /morpho_seed_candidate_evidence_invalid/)
  }
})

test('offline verifier binds resealed host commitments to baseline providers', async () => {
  const doc = (await discover()).evidenceDoc
  assert.equal(verify(doc), doc)
  const forged = structuredClone(doc)
  const fake = 'f'.repeat(64)
  forged.discovery.hostCommitments[1] = fake
  for (const row of forged.screenedCandidates) {
    if (!row.pinnedProof) continue
    row.pinnedProof.hostCommitments[1] = fake
    row.pinnedProofSha256 = (await import('node:crypto'))
      .createHash('sha256')
      .update(JSON.stringify(row.pinnedProof))
      .digest('hex')
  }
  assert.throws(() => verify(forged), /morpho_seed_candidate_evidence_invalid/)
  assert.throws(
    () => validateMorphoSeedCandidateEvidence(doc),
    /morpho_seed_candidate_evidence_invalid/,
  )
  assert.throws(
    () =>
      validateMorphoSeedCandidateEvidence(doc, {
        primaryProvider: 'https://one.example/rpc',
        secondaryProvider: 'https://three.example/rpc',
      }),
    /morpho_seed_candidate_evidence_invalid/,
  )
})
