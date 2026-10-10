import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { keccak256, stringToHex } from 'viem'

import { appendSnapshot, classifyStage, readLedger, STUDY } from './pyusd-staking-economic-exit.mjs'
import {
  appendHistory,
  collectAndAppendHistory,
  collectHistory,
  readLedger as readHistory,
  reconcile,
} from './pyusd-staking-redemption-history.mjs'

const BLOCK_HASH = `0x${'1'.repeat(64)}`
const OTHER_HASH = `0x${'2'.repeat(64)}`
const REQUEST_TOPIC = keccak256(stringToHex('RedemptionRequested(address,uint256,uint256,uint256)'))
const USER_TOPIC = `0x${'0'.repeat(24)}${'a'.repeat(40)}`
const historyHead = { number: '0x64', hash: BLOCK_HASH }
const historyOrigins = (primaryLogs, secondaryLogs = []) => [
  {
    provider: 'https://one.example',
    request: async (method) => {
      if (method === 'eth_getBlockByNumber') return historyHead
      if (method === 'eth_getLogs') return primaryLogs
      throw Error('unexpected_rpc')
    },
  },
  {
    provider: 'https://two.example',
    request: async (method) => {
      if (method === 'eth_getBlockByNumber') return historyHead
      if (method === 'eth_getLogs') return secondaryLogs
      throw Error('unexpected_rpc')
    },
  },
]

test('PRIME callable stage requires the exact holder shares, max, and nonzero simulated wYLDS', () => {
  const base = {
    primeShares: 100n,
    q: 40n,
    simulatedAssets: 41n,
    maxRedeem: 100n,
    paused: false,
    frozen: false,
  }
  assert.equal(classifyStage(base), 'prime_to_wylds_callable')
  assert.equal(classifyStage({ ...base, primeShares: 39n }), 'insufficient_prime_shares')
  assert.equal(classifyStage({ ...base, maxRedeem: 39n }), 'below_max_redeem')
  assert.equal(classifyStage({ ...base, simulatedAssets: null }), 'redeem_reverted')
  assert.equal(classifyStage({ ...base, simulatedAssets: 0n }), 'zero_wylds_out')
  assert.equal(classifyStage({ ...base, frozen: true }), 'holder_frozen')
})

test('request and completion duration is paid only with receipt attestation; boundary is censored', () => {
  const start = {
    kind: 'request',
    user: '0xabc',
    sharesRaw: '100',
    assetsRaw: '100',
    timestamp: 100,
  }
  const complete = {
    kind: 'completion',
    user: '0xabc',
    sharesRaw: '100',
    assetsRaw: '100',
    timestamp: 160,
    usdcPayout: 'receipt_transfer_attested',
  }
  assert.deepEqual(
    reconcile([start, complete]).map((r) => [r.kind, r.durationSeconds]),
    [['completed_paid', 60]],
  )
  assert.equal(
    reconcile([{ ...complete, usdcPayout: 'receipt_transfer_not_found' }])[0].kind,
    'left_censored_completion',
  )
  assert.equal(reconcile([start])[0].kind, 'right_censored_pending')
  assert.equal(
    reconcile([start, { ...complete, usdcPayout: 'receipt_transfer_not_found' }])[0].kind,
    'completed_unpaid_unproven',
  )
  assert.throws(() => reconcile([start, { ...complete, assetsRaw: '101' }]), /amount_mismatch/)
})

test('out-of-range discovered event cannot produce a sealed history row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pyusd-history-range-test-'))
  try {
    // Requested range is B91–100; the provider returns a real B90 event.
    const outOfRange = {
      blockNumber: '0x5a',
      blockHash: OTHER_HASH,
      transactionHash: OTHER_HASH,
      logIndex: '0x0',
      transactionIndex: '0x0',
      topics: [REQUEST_TOPIC, USER_TOPIC],
    }
    await assert.rejects(
      collectAndAppendHistory(historyOrigins([outOfRange]), 10, false, root),
      /log_range_invalid/,
    )
    assert.deepEqual(await readdir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('in-range event with inconsistent block header cannot produce a sealed history row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pyusd-history-header-test-'))
  try {
    const badHeader = {
      blockNumber: '0x5b',
      blockHash: OTHER_HASH,
      transactionHash: OTHER_HASH,
      logIndex: '0x0',
      transactionIndex: '0x0',
      topics: [REQUEST_TOPIC, USER_TOPIC],
    }
    await assert.rejects(
      collectAndAppendHistory(historyOrigins([badHeader]), 10, false, root),
      /event_disagreement/,
    )
    assert.deepEqual(await readdir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('full-window two-origin scan labels agreement only after every slice matches', async () => {
  const good = await collectHistory(historyOrigins([], []), 10, true)
  assert.equal(good.discoveryCompleteness, 'two_origin_raw_log_agreement')
  const phantom = {
    blockNumber: '0x5b',
    blockHash: OTHER_HASH,
    transactionHash: OTHER_HASH,
    logIndex: '0x0',
    transactionIndex: '0x0',
    topics: [REQUEST_TOPIC, USER_TOPIC],
  }
  await assert.rejects(
    collectHistory(historyOrigins([], [phantom]), 10, true),
    /full_window_disagreement/,
  )
})

test('local economic and history ledgers reject tampering and retain payout limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pyusd-economic-test-'))
  const history = await mkdtemp(join(tmpdir(), 'pyusd-history-test-'))
  try {
    const row = await appendSnapshot(
      {
        study: STUDY,
        routeKey: 'PYUSD → StakingVault [wYLDS]',
        destination: '0x19ebb35279a16207ec4ba82799cc64715065f7f6',
        assay: { pyusdPayout: 'not_attested' },
        finalPayout: 'unassessed',
        pyusdConversion: 'not_attested',
      },
      root,
    )
    assert.equal((await readLedger(root))[0].sha256, row.sha256)
    const file = join(root, '00000001.json')
    await writeFile(file, (await readFile(file, 'utf8')).replace('unassessed', 'assessed'))
    await assert.rejects(readLedger(root), /ledger_invalid/)

    await appendHistory(
      {
        study: 'pyusd_staking_redemption_history_v1',
        routeStudy: STUDY,
        chainId: 1,
        range: { startBlock: '1', endBlock: '1', endHash: BLOCK_HASH },
        origins: ['https://one.example', 'https://two.example'],
        discoveryCompleteness: 'single_origin_not_proven',
        finalPyusdPayout: 'not_attested',
        episodes: [],
        foundEvents: 0,
        paidMatchedEpisodes: 0,
      },
      history,
    )
    assert.equal((await readHistory(history)).length, 1)
    await assert.rejects(
      appendHistory({ study: 'poison', episodes: [] }, history),
      /ledger_invalid/,
    )
    assert.deepEqual(await readdir(history), ['00000001.json'])
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(history, { recursive: true, force: true })
  }
})
