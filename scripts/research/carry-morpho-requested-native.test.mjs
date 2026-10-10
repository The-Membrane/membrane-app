import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CARRY_EXIT_V2_FROZEN_ROUTES } from '../lib/carry-exit-v2-rpc-proof.mjs'
import {
  compareDueTargets,
  configuredOrigins,
  enqueue,
  readQueue,
  statusForRequest,
  tick,
} from './carry-morpho-requested-native.mjs'
import { verify } from './carry-morpho-requested-holder.mjs'

const route = CARRY_EXIT_V2_FROZEN_ROUTES.find((row) => row.kind === 'morpho')
const request = {
  routeKey: route.routeKey,
  destinationAddress: route.destination,
  owner: '0x1111111111111111111111111111111111111111',
  assetsRaw: '7654321',
}

test('live horizon outranks old expired censors when a tick has three slots', () => {
  const at = Date.parse('2026-10-03T10:00:00.000Z')
  const expired = [1, 2, 3, 4].map((number) => ({
    row: { issueId: `expired${number}` },
    target: { horizonHours: 1, deadlineUtc: '2026-10-03T09:00:00.000Z' },
  }))
  const live = {
    row: { issueId: 'live' },
    target: { horizonHours: 24, deadlineUtc: '2026-10-03T10:20:00.000Z' },
  }
  const selected = [...expired, live]
    .sort((a, b) => compareDueTargets(a, b, at, new Map()))
    .slice(0, 3)
  assert.equal(selected[0], live)
  assert.equal(selected.filter((row) => row === live).length, 1)
})
const start = Date.parse('2026-10-01T12:00:00.000Z')
const hash = (digit) => `0x${digit.repeat(64)}`
const origins = ['https://rpc.ankr.com/eth', 'https://lb.drpc.live/eth']
const clients = [{ request: async () => '0x' }, { request: async () => '0x' }]
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'morpho-native-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { dir: join(root, 'queue'), studyDir: join(root, 'study') }
}
const reader = async (_client, req, now, historical) => {
  const at = now()
  const later = at > start
  return {
    status: 'checked_at_finalized_block',
    source: {
      chainId: 1,
      blockNumber: later ? 26000002 : 26000001,
      blockHash: hash(later ? 'b' : 'a'),
      blockTime: new Date(at).toISOString(),
    },
    routeKey: req.routeKey,
    vault: { address: req.destinationAddress, assetAddress: route.asset },
    request: { assetsRaw: req.assetsRaw },
    position: { previewRedeemAssetsRaw: '99999999' },
    simulation: { status: 'success' },
  }
}

test('private intake persists exact tuple before RPC and remains idempotent', async (t) => {
  const { dir, studyDir } = fixture(t)
  const first = await enqueue(request, { dir, studyDir, now: () => start })
  assert.equal(first.status, 'queued')
  assert.equal(
    (await enqueue(request, { dir, studyDir, now: () => start + 1 })).status,
    'already_queued',
  )
  assert.equal(
    (
      await enqueue(
        {
          owner: request.owner,
          assetsRaw: request.assetsRaw,
          destinationAddress: request.destinationAddress,
          routeKey: request.routeKey,
        },
        { dir, studyDir, now: () => start + 2 },
      )
    ).status,
    'already_queued',
  )
  assert.equal(readQueue(dir).length, 1)
  assert.equal(statSync(dir).mode & 0o077, 0)
  assert.equal(statSync(join(dir, `${first.id}.json`)).mode & 0o077, 0)
  assert.deepEqual(
    (await statusForRequest(request, { dir, studyDir })).horizons.map((x) => x.state),
    ['queued', 'queued'],
  )
  let reads = 0
  const counted = async (...args) => {
    reads++
    return reader(...args)
  }
  assert.deepEqual(
    await tick({
      dir,
      studyDir,
      now: () => start,
      originUrls: origins,
      clients,
      readQuote: counted,
    }),
    { queued: 1, issued: 1, scored: 0, pending: 0, intakeFailed: 0, forecastValidated: false },
  )
  assert.equal(reads, 2)
  assert.equal((await verify(studyDir)).issues.length, 1)
  await tick({
    dir,
    studyDir,
    now: () => start + 5 * 60_000,
    originUrls: origins,
    clients,
    readQuote: counted,
  })
  assert.equal(reads, 2, 'a repeated tick must not issue the same tuple again')
  assert.deepEqual(
    (await statusForRequest(request, { dir, studyDir })).horizons.map((x) => x.state),
    ['pending', 'pending'],
  )
})

test('native tick scores frozen H1/H24 request once and returns only opaque status', async (t) => {
  const { dir, studyDir } = fixture(t)
  await enqueue(request, { dir, studyDir, now: () => start })
  await tick({ dir, studyDir, now: () => start, originUrls: origins, clients, readQuote: reader })
  const one = await tick({
    dir,
    studyDir,
    now: () => start + 3_600_000,
    originUrls: origins,
    clients,
    readQuote: reader,
  })
  assert.equal(one.scored, 1)
  const day = await tick({
    dir,
    studyDir,
    now: () => start + 24 * 3_600_000,
    originUrls: origins,
    clients,
    readQuote: reader,
  })
  assert.equal(day.scored, 1)
  const repeated = await tick({
    dir,
    studyDir,
    now: () => start + 24 * 3_600_000,
    originUrls: origins,
    clients,
    readQuote: reader,
  })
  assert.equal(repeated.scored, 0)
  const status = await statusForRequest(request, { dir, studyDir })
  assert.equal(JSON.stringify(status).includes(request.owner), false)
  assert.deepEqual(
    status.horizons.map((x) => x.state),
    ['measured_success', 'measured_success'],
  )
})

test('single-action tick scores one due target before issuing queued intake', async (t) => {
  const { dir, studyDir } = fixture(t)
  await enqueue(request, { dir, studyDir, now: () => start })
  await tick({ dir, studyDir, now: () => start, originUrls: origins, clients, readQuote: reader })
  const queued = {
    ...request,
    owner: '0x2222222222222222222222222222222222222222',
  }
  await enqueue(queued, { dir, studyDir, now: () => start + 10 * 60_000 })
  const scored = await tick({
    dir,
    studyDir,
    now: () => start + 3_600_000,
    originUrls: origins,
    clients,
    readQuote: reader,
    singleAction: true,
  })
  assert.equal(scored.scored, 1)
  assert.equal(scored.issued, 0)
  const issued = await tick({
    dir,
    studyDir,
    now: () => start + 3_600_001,
    originUrls: origins,
    clients,
    readQuote: reader,
    singleAction: true,
  })
  assert.equal(issued.scored, 0)
  assert.equal(issued.issued, 1)
})

test('tampered private queue fails closed; origin pair uses distinct operators', async (t) => {
  const { dir, studyDir } = fixture(t)
  const first = await enqueue(request, { dir, studyDir, now: () => start })
  const path = join(dir, `${first.id}.json`)
  const record = JSON.parse(readFileSync(path, 'utf8'))
  record.request.assetsRaw = '1'
  writeFileSync(path, `${JSON.stringify(record)}\n`)
  assert.throws(() => readQueue(dir), /requested_native_record_invalid/)
  assert.deepEqual(
    configuredOrigins(
      'https://eth-mainnet.g.alchemy.com/key,https://rpc.ankr.com/eth,https://lb.drpc.live/eth',
    ),
    origins,
  )
  assert.throws(() => configuredOrigins('https://rpc.ankr.com/eth'), /two_origins_required/)
})

test('request body only admits exact chosen tuple keys', async (t) => {
  const { dir } = fixture(t)
  await assert.rejects(() => enqueue({ ...request, extra: true }, { dir }), /request_invalid/)
  await assert.rejects(() => enqueue({ ...request, assetsRaw: '0' }, { dir }), /request_invalid/)
})

test('a failing due target does not starve newer unattempted targets', async (t) => {
  const { dir, studyDir } = fixture(t)
  const requests = ['1', '2', '3'].map((digit) => ({
    ...request,
    owner: `0x${digit.repeat(40)}`,
  }))
  const fairReader = async (_client, req, now) => {
    const at = now()
    if (req.owner === requests[0].owner && at >= start + 3_600_000)
      throw Error('transient_rpc_error')
    const offset = Math.floor((at - start) / 60_000)
    return {
      status: 'checked_at_finalized_block',
      source: {
        chainId: 1,
        blockNumber: 26000000 + offset,
        blockHash: hash(offset % 2 ? 'b' : 'a'),
        blockTime: new Date(at).toISOString(),
      },
      routeKey: req.routeKey,
      vault: { address: req.destinationAddress, assetAddress: route.asset },
      request: { assetsRaw: req.assetsRaw },
      position: { previewRedeemAssetsRaw: '99999999' },
      simulation: { status: 'success' },
    }
  }
  for (let i = 0; i < 3; i++) {
    await enqueue(requests[i], { dir, studyDir, now: () => start + i * 10 * 60_000 })
    const result = await tick({
      dir,
      studyDir,
      now: () => start + i * 10 * 60_000,
      originUrls: origins,
      clients,
      readQuote: fairReader,
    })
    assert.equal(result.issued, 1)
  }
  const result = await tick({
    dir,
    studyDir,
    now: () => start + 80 * 60_000,
    originUrls: origins,
    clients,
    readQuote: fairReader,
  })
  assert.equal(result.pending, 1)
  assert.equal(result.scored, 2)
  const state = await verify(studyDir)
  assert.equal(state.attempts.length, 1)
  assert.equal(state.scores.length, 2)
  const tooSoon = await tick({
    dir,
    studyDir,
    now: () => start + 85 * 60_000,
    originUrls: origins,
    clients,
    readQuote: fairReader,
  })
  assert.equal(tooSoon.pending, 0)
  const retry = await tick({
    dir,
    studyDir,
    now: () => start + 110 * 60_000,
    originUrls: origins,
    clients,
    readQuote: fairReader,
  })
  assert.equal(retry.pending, 1)
  const atCap = await tick({
    dir,
    studyDir,
    now: () => start + 140 * 60_000,
    originUrls: origins,
    clients,
    readQuote: fairReader,
  })
  assert.equal(atCap.pending, 0, 'two failed attempts stay bounded within the open window')
})

test('concurrent intake admits at most twelve active owner watches', async (t) => {
  const { dir, studyDir } = fixture(t)
  const burst = Array.from({ length: 14 }, (_, i) => ({
    ...request,
    owner: `0x${(i + 1).toString(16).padStart(40, '0')}`,
  }))
  const results = await Promise.allSettled(
    burst.map((entry) => enqueue(entry, { dir, studyDir, now: () => start })),
  )
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 12)
  assert.equal(
    results.filter(
      (x) => x.status === 'rejected' && x.reason.message === 'requested_native_active_limit',
    ).length,
    2,
  )
  assert.equal(readQueue(dir).length, 12)
})

test('failed oldest intake cannot prevent due scoring or later owner issue', async (t) => {
  const { dir, studyDir } = fixture(t)
  const good = request
  const bad = { ...request, owner: `0x${'2'.repeat(40)}` }
  const later = { ...request, owner: `0x${'3'.repeat(40)}` }
  let recovered = false
  const read = async (_client, req, now) => {
    if (req.owner === bad.owner && !recovered) throw Error('rpc_secret_or_user_data_must_not_log')
    const at = now()
    const offset = Math.floor((at - start) / 60_000)
    return {
      status: 'checked_at_finalized_block',
      source: {
        chainId: 1,
        blockNumber: 26000000 + offset,
        blockHash: hash(offset % 2 ? 'b' : 'a'),
        blockTime: new Date(at).toISOString(),
      },
      routeKey: req.routeKey,
      vault: { address: req.destinationAddress, assetAddress: route.asset },
      request: { assetsRaw: req.assetsRaw },
      position: { previewRedeemAssetsRaw: '99999999' },
      simulation: { status: 'success' },
    }
  }
  await enqueue(good, { dir, studyDir, now: () => start })
  await tick({ dir, studyDir, now: () => start, originUrls: origins, clients, readQuote: read })
  await enqueue(bad, { dir, studyDir, now: () => start + 1000 })
  await enqueue(later, { dir, studyDir, now: () => start + 2000 })
  const first = await tick({
    dir,
    studyDir,
    now: () => start + 60 * 60_000,
    originUrls: origins,
    clients,
    readQuote: read,
  })
  assert.equal(first.scored, 1)
  assert.equal(first.intakeFailed, 1)
  assert.equal((await statusForRequest(bad, { dir, studyDir })).state, 'retrying')
  const second = await tick({
    dir,
    studyDir,
    now: () => start + 65 * 60_000,
    originUrls: origins,
    clients,
    readQuote: read,
  })
  assert.equal(second.issued, 1)
  assert.equal((await statusForRequest(later, { dir, studyDir })).state, 'issued')
  await tick({
    dir,
    studyDir,
    now: () => start + 95 * 60_000,
    originUrls: origins,
    clients,
    readQuote: read,
  })
  await tick({
    dir,
    studyDir,
    now: () => start + 130 * 60_000,
    originUrls: origins,
    clients,
    readQuote: read,
  })
  const thirdFailureAt = start + 130 * 60_000
  assert.equal(
    (await statusForRequest(bad, { dir, studyDir, now: () => thirdFailureAt })).state,
    'quarantined',
  )
  const cooled = await tick({
    dir,
    studyDir,
    now: () => thirdFailureAt + 5 * 60 * 60_000,
    originUrls: origins,
    clients,
    readQuote: read,
  })
  assert.equal(cooled.issued, 0)
  recovered = true
  const rearmed = await tick({
    dir,
    studyDir,
    now: () => thirdFailureAt + 6 * 60 * 60_000,
    originUrls: origins,
    clients,
    readQuote: read,
  })
  assert.equal(rearmed.issued, 1)
  assert.equal((await statusForRequest(bad, { dir, studyDir })).state, 'issued')
  assert.equal((await verify(studyDir)).issues.length, 3)
})

test('four bounded retry cycles preserve receipts and end in explicit exhausted state', async (t) => {
  const { dir, studyDir } = fixture(t)
  await enqueue(request, { dir, studyDir, now: () => start })
  const failedReader = async () => {
    throw Error('private_rpc_body_should_not_be_stored')
  }
  for (const minutes of [0, 30, 60, 420, 450, 480, 840, 870, 900, 1260, 1290, 1320]) {
    const result = await tick({
      dir,
      studyDir,
      now: () => start + minutes * 60_000,
      originUrls: origins,
      clients,
      readQuote: failedReader,
    })
    assert.equal(result.intakeFailed, 1)
  }
  const status = await statusForRequest(request, {
    dir,
    studyDir,
    now: () => start + 2000 * 60_000,
  })
  assert.equal(status.state, 'exhausted')
  assert.equal(readdirSync(dir).filter((name) => name.startsWith('.fail-')).length, 12)
  assert.equal(
    readdirSync(dir).some((name) => name.includes('private_rpc_body')),
    false,
  )
  const again = await tick({
    dir,
    studyDir,
    now: () => start + 3000 * 60_000,
    originUrls: origins,
    clients,
    readQuote: failedReader,
  })
  assert.equal(again.intakeFailed, 0)
  assert.equal(again.issued, 0)
})
