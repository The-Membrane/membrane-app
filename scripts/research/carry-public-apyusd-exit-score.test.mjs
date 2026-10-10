import assert from 'node:assert/strict'
import test from 'node:test'

import { scoreApyUsd } from './carry-public-apyusd-exit-score.mjs'
import { ASSET, ROUTE, VAULT } from './carry-public-apyusd-exit-common.mjs'

test('a lagging first origin pair does not hide a finalized second pair', async () => {
  const targetAtUtc = '2026-10-01T01:00:00.000Z'
  const captureDeadlineUtc = '2026-10-01T03:00:00.000Z'
  const plan = { horizonHours: 1, targetAtUtc, captureDeadlineUtc }
  const issue = {
    sequence: 1,
    sha256: 'a'.repeat(64),
    routeKey: ROUTE,
    destination: VAULT,
    originalAsset: ASSET,
    holder: `0x${'b'.repeat(40)}`,
    baseline: { number: '100' },
    targets: [plan],
    cases: [{ label: 'q1', assetsRaw: null }],
  }
  const pairA = [{ provider: 'first-a' }, { provider: 'first-b' }]
  const pairB = [{ provider: 'second-a' }, { provider: 'second-b' }]
  const target = {
    number: '101',
    hash: `0x${'c'.repeat(64)}`,
    timestamp: Date.parse(targetAtUtc) / 1000,
  }
  const calls = []
  const sealed = []
  const summary = await scoreApyUsd({
    urls: ['https://first.example', 'https://second.example'],
    pairs: [pairA, pairB],
    now: () => new Date('2026-10-01T01:10:00.000Z'),
    loadIssues: async () => [issue],
    loadScores: async () => [],
    selectTarget: async (primary) => {
      calls.push(primary.provider)
      return primary.provider === 'first-a'
        ? { status: 'not_finalized' }
        : { status: 'target', target, prior: { number: '100' } }
    },
    attest: async () => ({ vaultImpl: 'same' }),
    append: async (row) => {
      sealed.push(row)
    },
  })
  assert.deepEqual(calls, ['first-a', 'second-a'])
  assert.deepEqual(summary, { due: 1, attempted: 1, scored: 1, retries: 0 })
  assert.equal(sealed.length, 1)
  assert.equal(sealed[0].target.originA, 'second-a')
})
