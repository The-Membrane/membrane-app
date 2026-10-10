import assert from 'node:assert/strict'
import test from 'node:test'
import { toEventSelector } from 'viem'
import { SILO, USDE } from './susde-public-pending-exit-common.mjs'
import {
  linkVerifiedRequestToPayout,
  readVerifiedRequestToPayout,
} from './susde-public-request-to-payout-episode.mjs'

const holder = '0x6142eb927529974c5cded66dafc57cb5aaaf73ab'
const requestTx = `0x${'a'.repeat(64)}`
const payoutTx = `0x${'b'.repeat(64)}`
const requestHash = `0x${'c'.repeat(64)}`
const anchorHash = `0x${'d'.repeat(64)}`
const topic = (address) => `0x${address.slice(2).padStart(64, '0')}`
const requestAt = '2026-09-30T23:49:23.000Z'
const anchorAt = '2026-09-30T23:57:11.000Z'
const cooldownEnd = '2026-10-01T23:49:23.000Z'
const payoutAt = '2026-10-01T23:49:59.000Z'
const issuedAt = '2026-10-01T00:05:00.000Z'
const requestCapturedAt = '2026-10-01T00:10:00.000Z'
const deliveryWitnessedAt = '2026-10-02T00:00:00.000Z'
const archiveCapturedAt = '2026-10-02T00:03:00.000Z'
const sidecarAttestedAt = '2026-10-02T00:04:00.000Z'
const seconds = (date) => Math.floor(Date.parse(date) / 1000)
const selectedLog = {
  blockNumber: '0x18e2874',
  blockHash: requestHash,
  transactionHash: requestTx,
  logIndex: '0x1cf',
  data: `0x${100n.toString(16).padStart(64, '0')}${50n.toString(16).padStart(64, '0')}`,
}

function fixture() {
  const requestLog = structuredClone(selectedLog)
  const issue = {
    sequence: 3,
    sha256: 'a'.repeat(64),
    holder,
    pendingAssetsRaw: '100',
    issuedAtUtc: issuedAt,
    anchor: { blockNumber: '26093723', blockHash: anchorHash, blockAtUtc: anchorAt },
    cooldownEndUtc: cooldownEnd,
    screened: [
      {
        status: 'selected',
        discoveryBlock: '26093684',
        discoveryTransactionHash: requestTx,
        discoveryLogIndex: '463',
        receiptProof: { discoveryLog: requestLog, receiptLog: requestLog },
      },
    ],
  }
  const request = {
    sequence: 1,
    sha256: 'b'.repeat(64),
    issueSequence: 3,
    issueSha256: issue.sha256,
    holder,
    anchorHash,
    selectedLog: requestLog,
    twoOriginObservedLogAgreement: true,
    headerChainContinuityProven: false,
    cooldownAtExecutionProven: false,
    cryptographicAbsenceProven: false,
    sameEpisodePayoutProven: false,
    capturedAtUtc: requestCapturedAt,
    origins: [
      {
        selectedHeader: { timestamp: `0x${seconds(requestAt).toString(16)}` },
        transaction: { hash: requestTx },
        receipt: { transactionHash: requestTx },
      },
    ],
  }
  const transfer = {
    address: USDE,
    topics: [
      toEventSelector('Transfer(address,address,uint256)').toLowerCase(),
      topic(SILO),
      topic(holder),
    ],
    data: '0x64',
  }
  const delivery = {
    sequence: 1,
    sha256: 'c'.repeat(64),
    issueSequence: 3,
    issueSha256: issue.sha256,
    holder,
    frozenPendingAssetsRaw: '100',
    transactionHash: payoutTx,
    deliveredAtUtc: payoutAt,
    witnessedAtUtc: deliveryWitnessedAt,
    origins: [
      { block: { number: '0x18e4000' }, tx: { hash: payoutTx }, receipt: { logs: [transfer] } },
    ],
  }
  const archive = {
    summary: {
      complete: true,
      preDeliveryWithdrawLogs: 0,
      issueSha256: issue.sha256,
      deliverySha256: delivery.sha256,
    },
    rows: [{ sha256: 'd'.repeat(64), capturedAtUtc: archiveCapturedAt }],
  }
  const sidecar = {
    sequence: 1,
    sha256: 'e'.repeat(64),
    issueSequence: 3,
    issueSha256: issue.sha256,
    deliverySha256: delivery.sha256,
    archiveFinalSha256: archive.rows[0].sha256,
    archiveWindows: 1,
    holder,
    transactionHash: payoutTx,
    attestedAtUtc: sidecarAttestedAt,
    observedPendingToPayoutSeconds: seconds(payoutAt) - seconds(anchorAt),
    sameEpisodeEvidenceLevel: 'two_origin_rpc_log_attested',
    cryptographicAbsenceProven: false,
    forecastValidated: false,
  }
  return { request, issue, sidecars: [sidecar], deliveries: [delivery], archive }
}

test('links one observed request to final-asset payout without a future claim', () => {
  const result = linkVerifiedRequestToPayout(fixture())
  assert.equal(result.status, 'linked_observed_episode')
  assert.equal(result.observedRequestToPayoutSeconds, seconds(payoutAt) - seconds(requestAt))
  assert.equal(result.rawAssets, '100')
  assert.equal(result.requestSharesRaw, '50')
  assert.equal(result.requestTransactionHash, requestTx)
  assert.equal(result.payoutTransactionHash, payoutTx)
  assert.equal(result.payoutAtUtc, payoutAt)
  assert.equal(result.localEvidenceAvailableAtUtc, sidecarAttestedAt)
  assert.equal(result.localEvidenceAvailabilityClock, 'unwitnessed_local_wall_clock')
  assert.equal(result.cryptographicAbsenceProven, false)
  assert.equal(result.headerChainContinuityProven, false)
  assert.equal(result.implementationIdentityVerified, false)
  assert.equal(result.forecastValidated, false)
  assert.equal(result.futureDurationClaim, false)
})

test('availability uses every verified local capture clock, including nonfinal archive rows', () => {
  const data = fixture()
  const laterArchiveCapture = '2026-10-02T00:06:00.000Z'
  data.archive.rows.unshift({ sha256: 'f'.repeat(64), capturedAtUtc: laterArchiveCapture })
  data.sidecars[0].archiveWindows = 2
  const result = linkVerifiedRequestToPayout(data)
  assert.equal(result.localEvidenceAvailableAtUtc, laterArchiveCapture)
  assert.equal(result.payoutAtUtc, payoutAt)
})

test('rejects invalid local evidence clocks', () => {
  for (const mutate of [
    (data) => (data.issue.issuedAtUtc = 'invalid'),
    (data) => (data.request.capturedAtUtc = 'invalid'),
    (data) => (data.deliveries[0].witnessedAtUtc = 'invalid'),
    (data) => (data.archive.rows[0].capturedAtUtc = 'invalid'),
    (data) => (data.sidecars[0].attestedAtUtc = 'invalid'),
  ]) {
    const data = fixture()
    mutate(data)
    assert.throws(() => linkVerifiedRequestToPayout(data), /susde_clock_invalid/)
  }
})

test('missing sidecar is explicit, with no episode claim', () => {
  assert.deepEqual(linkVerifiedRequestToPayout({ ...fixture(), sidecars: [] }), {
    study: 'susde_public_request_to_payout_episode_v1',
    status: 'sidecar_missing',
    issueSequence: 3,
  })
})

test('rejects mismatched amount, selected request, payout, and archive continuity', () => {
  const amount = fixture()
  amount.issue.pendingAssetsRaw = '101'
  assert.throws(() => linkVerifiedRequestToPayout(amount), /request_payout_binding_invalid/)
  const request = fixture()
  request.request.selectedLog.transactionHash = `0x${'f'.repeat(64)}`
  assert.throws(() => linkVerifiedRequestToPayout(request), /request_payout_binding_invalid/)
  const payout = fixture()
  payout.sidecars[0].transactionHash = `0x${'f'.repeat(64)}`
  assert.throws(() => linkVerifiedRequestToPayout(payout), /request_payout_binding_invalid/)
  const archive = fixture()
  archive.archive.summary.preDeliveryWithdrawLogs = 1
  assert.throws(() => linkVerifiedRequestToPayout(archive), /request_payout_binding_invalid/)
})

test('rejects premature payout and chronology mismatch', () => {
  const premature = fixture()
  premature.deliveries[0].deliveredAtUtc = anchorAt
  premature.sidecars[0].observedPendingToPayoutSeconds = 0
  assert.throws(() => linkVerifiedRequestToPayout(premature), /request_payout_chronology_invalid/)
  const shifted = fixture()
  shifted.request.origins[0].selectedHeader.timestamp = `0x${seconds(payoutAt).toString(16)}`
  assert.throws(() => linkVerifiedRequestToPayout(shifted), /request_payout_chronology_invalid/)
})

test('read path calls each verifier and uses its verified archive in sidecar replay', async () => {
  const data = fixture()
  const calls = []
  const result = await readVerifiedRequestToPayout({
    loadRequest: async () => {
      calls.push('request')
      return { issue: data.issue, rows: [data.request] }
    },
    loadArchive: async () => {
      calls.push('archive')
      return data.archive
    },
    loadDeliveries: async () => {
      calls.push('delivery')
      return data.deliveries
    },
    loadSidecars: async (_out, _issueOut, _deliveryOut, _archiveOut, cachedArchive) => {
      calls.push('sidecar')
      assert.equal(await cachedArchive(), data.archive)
      return data.sidecars
    },
  })
  assert.equal(result.status, 'linked_observed_episode')
  assert.deepEqual(calls.sort(), ['archive', 'delivery', 'request', 'sidecar'])
})
