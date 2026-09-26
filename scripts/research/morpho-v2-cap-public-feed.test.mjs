import assert from 'node:assert/strict'
import test from 'node:test'

import { buildFeed, capMagnitude, seal } from './morpho-v2-cap-public-feed.mjs'

const tx = (digit) => `0x${digit.repeat(64)}`
const vault = `0x${'a'.repeat(40)}`
const cap = (kind, transactionHash, logIndex, observedAt) => ({
  kind: 'submit',
  raw: { transactionHash, logIndex, blockNumber: 100 + logIndex },
  detail: {
    vault,
    selector: kind === 'absolute' ? '0xf6f98fd5' : '0x2438525b',
    data: kind === 'absolute' ? '0xf6f98fd500' : '0x2438525b00',
    executableAt: '1790585111',
    cap: {
      kind,
      allocationId: tx('f'),
      proposedCap: kind === 'absolute' ? '5000000000000' : '1000000000000000000',
    },
  },
  firstObservedAt: observedAt,
})
const lifecycle = (kind, submit, transactionHash, observedAt) => ({
  kind,
  raw: { transactionHash },
  detail: {
    vault: submit.detail.vault,
    selector: submit.detail.selector,
    data: submit.detail.data,
  },
  firstObservedAt: observedAt,
})
const stamp = '2026-09-26T13:54:56.399Z'
const state = { throughBlock: 26_061_965 }

test('queued cap increase is allocation headroom only and retains its source', () => {
  const submitted = cap('absolute', tx('1'), 7, stamp)
  const feed = buildFeed([{ events: [submitted] }], state, stamp)
  assert.equal(feed.items.length, 1)
  assert.equal(feed.items[0].lifecycle, 'queued')
  assert.equal(feed.items[0].direction, 'increase')
  assert.equal(feed.items[0].dimension, 'absolute allocation cap')
  assert.equal(feed.items[0].allocationId, tx('f'))
  assert.equal(feed.items[0].proposedCapRaw, '5000000000000')
  assert.equal(feed.items[0].capUnit, 'asset-base-units')
  assert.equal(feed.items[0].sourceUrl, `https://etherscan.io/tx/${tx('1')}`)
  assert.match(feed.limitation, /does not measure exit capacity/)
  assert.match(seal(feed).sha256, /^[0-9a-f]{64}$/)
})

test('exact-key Accept executes one leg; unrelated leg stays queued', () => {
  const absolute = cap('absolute', tx('1'), 7, stamp)
  const relative = cap('relative', tx('1'), 8, stamp)
  const accept = lifecycle('accept', absolute, tx('2'), stamp)
  const feed = buildFeed([{ events: [absolute, relative, accept] }], state, stamp)
  assert.equal(
    feed.items.find((item) => item.dimension === 'absolute allocation cap').lifecycle,
    'executed',
  )
  assert.equal(
    feed.items.find((item) => item.dimension === 'relative allocation cap').lifecycle,
    'queued',
  )
  assert.equal(
    feed.items.find((item) => item.dimension === 'relative allocation cap').capUnit,
    '1e18-fraction-of-vault-assets',
  )
})

test('exact-key resubmission starts a new queue; later Revoke cancels it', () => {
  const first = cap('absolute', tx('1'), 7, stamp)
  const second = cap('absolute', tx('2'), 9, stamp)
  const accepted = lifecycle('accept', first, tx('3'), stamp)
  const revoked = lifecycle('revoke', second, tx('4'), stamp)
  const feed = buildFeed([{ events: [first, accepted, second, revoked] }], state, stamp)
  assert.equal(feed.items.length, 1)
  assert.equal(feed.items[0].id, `${tx('2')}:9`)
  assert.equal(feed.items[0].lifecycle, 'canceled')
  assert.equal(feed.items[0].statusTxUrl, `https://etherscan.io/tx/${tx('4')}`)
})

test('cap magnitudes retain raw asset units and 1e18 relative semantics', () => {
  assert.deepEqual(capMagnitude('absolute', '5000000000000'), {
    proposedCapRaw: '5000000000000',
    capUnit: 'asset-base-units',
  })
  assert.deepEqual(capMagnitude('relative', '1000000000000000000'), {
    proposedCapRaw: '1000000000000000000',
    capUnit: '1e18-fraction-of-vault-assets',
  })
  assert.throws(() => capMagnitude('relative', '1000000000000000001'), /Invalid relative cap/)
})
