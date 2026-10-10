import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  captureEpisode,
  selectEpisodePeers,
  validateEpisode,
  validateEpisodeRows,
  attestSameEpisode,
  STUDY,
} from './susde-public-pending-payout-v2.mjs'

const hash = (digit) => `0x${digit.repeat(64)}`
const holder = `0x${'1'.repeat(40)}`
const block = (number, digit) => ({
  number: `0x${number.toString(16)}`,
  hash: hash(digit),
  parentHash: hash('0'),
  timestamp: '0x64',
})
const issue = {
  sequence: 3,
  sha256: 'issue-sha',
  holder,
  anchor: { blockNumber: '10', blockHash: hash('a'), blockAtUtc: '1970-01-01T00:01:40.000Z' },
}
const payoutBlock = block(20, 'b')
const tx = {
  hash: hash('c'),
  blockHash: payoutBlock.hash,
  blockNumber: '0x14',
  transactionIndex: '0x0',
  from: holder,
  to: '0x9d39a5de30e57443bff2a8307a4256c8797a3497',
  input: '0xdead',
  nonce: '0x7',
}
const delivery = {
  sha256: 'delivery-sha',
  issueSequence: 3,
  issueSha256: issue.sha256,
  minedDeliveryProven: true,
  episodeAttribution: 'unresolved',
  transactionHash: tx.hash,
  deliveredAtUtc: '1970-01-01T00:03:20.000Z',
  origins: [{ block: payoutBlock, tx, receipt: { status: '0x1', transactionIndex: '0x0' } }],
}
const archive = {
  rows: [
    { sha256: 'last-sha', toBlock: '20', origins: [{ endHeader: { hash: payoutBlock.hash } }] },
  ],
  summary: {
    complete: true,
    preDeliveryWithdrawLogs: 0,
    issueSequence: 3,
    issueSha256: issue.sha256,
    deliverySha256: delivery.sha256,
    endBlock: '20',
  },
}
const cooldown = `0x${'0'.repeat(128)}`
const origin = (provider) => ({
  provider,
  providerHost: new URL(provider).hostname,
  chainId: '0x1',
  anchorHeader: block(10, 'a'),
  payoutHeader: payoutBlock,
  finalized: block(21, 'd'),
  anchorNonce: '0x7',
  payoutNonce: '0x8',
  tx,
  postCooldown: cooldown,
})
const row = () => ({
  study: STUDY,
  sequence: 1,
  previousSha256: null,
  issueSequence: 3,
  issueSha256: issue.sha256,
  deliverySha256: delivery.sha256,
  archiveFinalSha256: 'last-sha',
  archiveWindows: 1,
  transactionHash: tx.hash,
  holder,
  attestedAtUtc: '1970-01-01T00:03:21.000Z',
  minedDeliveryProven: true,
  sameEpisodeEvidenceLevel: 'two_origin_rpc_log_attested',
  cryptographicAbsenceProven: false,
  forecastValidated: false,
  observedPendingToPayoutSeconds: 100,
  origins: [origin('https://one.example/rpc'), origin('https://two.example/rpc')],
})
const context = { issue, delivery, archive }
const rejected = (mutate, code) => {
  const candidate = row()
  mutate(candidate)
  assert.throws(() => validateEpisode(candidate, context), new RegExp(code))
}

test('valid same-episode sidecar keeps the RPC absence qualification', () => {
  assert.equal(
    validateEpisode(row(), context).sameEpisodeEvidenceLevel,
    'two_origin_rpc_log_attested',
  )
})
test('anchor nonce must equal transaction nonce', () =>
  rejected((x) => {
    x.origins.forEach((o) => {
      o.anchorNonce = '0x6'
    })
  }, 'nonce_invalid'))
test('payout nonce must be exactly transaction nonce plus one', () =>
  rejected((x) => {
    x.origins.forEach((o) => {
      o.payoutNonce = '0x9'
    })
  }, 'nonce_invalid'))
test('cleared queue is mandatory', () =>
  rejected((x) => {
    x.origins.forEach((o) => {
      o.postCooldown = `0x${'0'.repeat(127)}1`
    })
  }, 'queue_not_clear'))
test('archive gap and prior Withdraw log cannot promote', () => {
  assert.throws(
    () =>
      validateEpisode(row(), {
        ...context,
        archive: { ...archive, summary: { ...archive.summary, complete: false } },
      }),
    /binding_invalid/,
  )
  assert.throws(
    () =>
      validateEpisode(row(), {
        ...context,
        archive: { ...archive, summary: { ...archive.summary, preDeliveryWithdrawLogs: 1 } },
      }),
    /binding_invalid/,
  )
})
test('archive final row hash replay cannot promote', () =>
  rejected((x) => {
    x.archiveFinalSha256 = 'wrong'
  }, 'binding_invalid'))
test('same host alias is rejected even with distinct URLs', () =>
  rejected((x) => {
    x.origins[1].provider = 'https://www.one.example/other'
    x.origins[1].providerHost = 'one.example'
  }, 'origins_invalid'))
test('one origin disagreement is rejected', () =>
  rejected((x) => {
    x.origins[1].anchorNonce = '0x6'
  }, 'origin_disagreement'))
test('duplicate attribution record cannot alter the frozen sequence', () => {
  assert.throws(() => validateEpisodeRows([row(), row()], context), /susde_episode_duplicate/)
  rejected((x) => {
    x.sequence = 2
  }, 'binding_invalid')
})

test('capture uses canonical pinned blocks and bounded read-only RPC', async () => {
  const calls = []
  const peer = (provider) => ({
    provider,
    request: async (method, params) => {
      calls.push([method, params])
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber')
        return params[0] === 'finalized'
          ? block(21, 'd')
          : params[0] === '0xa'
            ? block(10, 'a')
            : payoutBlock
      if (method === 'eth_getTransactionCount')
        return params[1].blockHash === hash('a') ? '0x7' : '0x8'
      if (method === 'eth_getTransactionByHash') return tx
      if (method === 'eth_call') return cooldown
      throw Error('unexpected')
    },
  })
  const result = await captureEpisode({
    issue,
    delivery,
    peers: [peer('https://one.example'), peer('https://two.example')],
  })
  assert.equal(result.status, 'captured')
  assert.equal(calls.length, 16)
  assert.equal(calls.filter(([method]) => method === 'eth_getTransactionCount').length, 4)
  assert.ok(
    calls
      .filter(([method]) => method === 'eth_getTransactionCount')
      .every(([, params]) => params[1].requireCanonical),
  )
})

test('attribution reuses the archive pair ahead of unreliable configured origins', () => {
  const peers = ['alchemy.example', 'infura.example', 'ankr.example'].map((name) => ({
    provider: `https://${name}`,
  }))
  assert.deepEqual(selectEpisodePeers(peers, ['alchemy.example|ankr.example']), [
    peers[0],
    peers[2],
  ])
})

test('incomplete real archive returns typed status before clients are created', async () => {
  const result = await attestSameEpisode({
    urls: ['https://one.example', 'https://two.example'],
    loadArchive: async () => ({
      rows: [],
      summary: { complete: false, preDeliveryWithdrawLogs: 0 },
    }),
    clients: () => {
      throw Error('RPC should not be touched')
    },
  })
  assert.equal(result.status, 'susde_episode_archive_incomplete')
})
