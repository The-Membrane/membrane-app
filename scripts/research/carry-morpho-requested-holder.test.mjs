import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CARRY_EXIT_V2_FROZEN_ROUTES } from '../lib/carry-exit-v2-rpc-proof.mjs'
import {
  defaultReader,
  exactSubject,
  issue,
  originHost,
  score,
  verify,
} from './carry-morpho-requested-holder.mjs'

const route = CARRY_EXIT_V2_FROZEN_ROUTES.find((x) => x.kind === 'morpho')
const owner = '0x1111111111111111111111111111111111111111'
const request = (assetsRaw = '7654321') => ({
  routeKey: route.routeKey,
  destinationAddress: route.destination,
  owner,
  assetsRaw,
})
const start = Date.parse('2026-10-01T12:00:00.000Z')
const hash = `0x${'a'.repeat(64)}`
const futureHash = `0x${'b'.repeat(64)}`
const source = (
  at,
  blockNumber = at > start ? 26_000_002 : 26_000_001,
  blockHash = at > start ? futureHash : hash,
) => ({
  chainId: 1,
  blockNumber,
  blockHash,
  blockTime: new Date(at).toISOString(),
})
const quote = (
  req,
  at,
  { claim = '99999999', status = 'success', blockNumber, blockHash } = {},
) => ({
  status: 'checked_at_finalized_block',
  source: source(at, blockNumber, blockHash),
  routeKey: req.routeKey,
  vault: { address: req.destinationAddress, assetAddress: route.asset },
  request: { assetsRaw: req.assetsRaw },
  position: { previewRedeemAssetsRaw: claim },
  simulation:
    status === 'success'
      ? { status }
      : { status, reason: 'requested_amount_exceeds_preview_claim' },
})
const clients = [{ request: async () => '0x' }, { request: async () => '0x' }]
const originUrls = ['https://eth-mainnet.g.alchemy.com/key', 'https://mainnet.infura.io/v3/key']
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-requested-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function reseal(path, mutate) {
  const record = JSON.parse(readFileSync(path, 'utf8'))
  mutate(record)
  delete record.sha256
  record.sha256 = createHash('sha256').update(JSON.stringify(record)).digest('hex')
  writeFileSync(path, `${JSON.stringify(record)}\n`)
}
const reader =
  (at, options = {}) =>
  async (_client, req, _now, historical) => {
    if (historical) assert.equal(historical.blockHash, at > start ? futureHash : hash)
    return quote(req, at, options)
  }

test('default TypeScript quote reader resolves in local Node runtime', async () => {
  await assert.rejects(() => defaultReader(null, {}, () => start), /morpho_exit_request_invalid/)
})

test('exact arbitrary owner/Q route is frozen, with both due windows', async (t) => {
  const dir = fixture(t),
    req = request('7654321')
  const baseline = await issue({
    request: req,
    clients,
    originUrls,
    dir,
    now: () => start,
    readQuote: reader(start),
  })
  assert.equal(baseline.request.assetsRaw, '7654321')
  assert.equal(baseline.frozen.owner, owner)
  assert.equal(baseline.targets[0].horizonHours, 1)
  assert.equal(baseline.targets[1].horizonHours, 24)
  assert.equal(baseline.claims.minedPayoutProved, false)
  assert.deepEqual(
    (await verify(dir)).issues.map((x) => x.issueId),
    [baseline.issueId],
  )
  assert.equal(
    (
      await score({
        issueId: baseline.issueId,
        horizonHours: 1,
        clients,
        originUrls,
        dir,
        now: () => start + 30 * 60_000,
        readQuote: reader(start),
      })
    ).status,
    'not_due',
  )
  const h1 = await score({
    issueId: baseline.issueId,
    horizonHours: 1,
    clients,
    originUrls,
    dir,
    now: () => start + HOUR,
    readQuote: reader(start + HOUR),
  })
  assert.equal(h1.outcome, 'measured_success')
  const h24 = await score({
    issueId: baseline.issueId,
    horizonHours: 24,
    clients,
    originUrls,
    dir,
    now: () => start + 24 * HOUR,
    readQuote: reader(start + 24 * HOUR),
  })
  assert.equal(h24.outcome, 'measured_success')
  assert.equal((await verify(dir)).scores.length, 2)
})
const HOUR = 3_600_000

test('wrong route/destination and Q mutation are rejected before issue or score', async (t) => {
  const dir = fixture(t)
  assert.throws(
    () =>
      exactSubject({
        ...request(),
        destinationAddress: '0x2222222222222222222222222222222222222222',
      }),
    /subject_unknown/,
  )
  assert.throws(() => exactSubject({ ...request(), routeKey: 'made-up' }), /subject_unknown/)
  assert.throws(() => exactSubject({ ...request(), assetsRaw: 7654321 }), /request_invalid/)
  const first = await issue({
    request: request(),
    clients,
    originUrls,
    dir,
    now: () => start,
    readQuote: reader(start),
  })
  await assert.rejects(
    () =>
      score({
        issueId: first.issueId,
        horizonHours: 1,
        request: request('7654322'),
        clients,
        originUrls,
        dir,
        now: () => start + HOUR,
        readQuote: reader(start + HOUR),
      }),
    /tuple_changed/,
  )
  await assert.rejects(
    () =>
      score({
        issueId: first.issueId,
        horizonHours: 1,
        request: { ...request(), owner: '0x2222222222222222222222222222222222222222' },
        clients,
        originUrls,
        dir,
        now: () => start + HOUR,
        readQuote: reader(start + HOUR),
      }),
    /tuple_changed/,
  )
  assert.equal((await verify(dir)).scores.length, 0)
})

test('below-Q EVM revert is measured failure, RPC failure is censored', async (t) => {
  const dir = fixture(t)
  const a = await issue({
    request: request('7654321'),
    clients,
    originUrls,
    dir,
    now: () => start,
    readQuote: reader(start),
  })
  const fail = await score({
    issueId: a.issueId,
    horizonHours: 1,
    clients,
    originUrls,
    dir,
    now: () => start + HOUR,
    readQuote: reader(start + HOUR, { claim: '7000000', status: 'evm_revert' }),
  })
  assert.equal(fail.outcome, 'measured_failure')
  assert.equal(fail.measurement.claimRaw, '7000000')
  assert.equal(fail.measurement.reason, 'requested_amount_exceeds_preview_claim')
  const pending = await score({
    issueId: a.issueId,
    horizonHours: 24,
    clients,
    originUrls,
    dir,
    now: () => start + 24 * HOUR,
    readQuote: async () => {
      throw Error('rpc timeout')
    },
  })
  assert.equal(pending.status, 'pending')
  assert.equal(pending.reason, 'rpc_or_measurement_error')
  assert.equal((await verify(dir)).scores.length, 1)
  const recovered = await score({
    issueId: a.issueId,
    horizonHours: 24,
    clients,
    originUrls,
    dir,
    now: () => start + 24 * HOUR + 60_000,
    readQuote: reader(start + 24 * HOUR + 60_000),
  })
  assert.equal(recovered.outcome, 'measured_success')
  assert.equal((await verify(dir)).attempts.length, 1)
  assert.equal((await verify(dir)).scores.length, 2)
})

test('two-origin quote disagreement and alias origins fail closed', async (t) => {
  const dir = fixture(t),
    req = request()
  assert.equal(originHost('https://www.g.alchemy.com./x'), 'alchemy')
  assert.equal(originHost('https://eth-mainnet.g.alchemy.com/key'), 'alchemy')
  assert.equal(originHost('https://lb.drpc.live/key'), 'drpc')
  assert.equal(originHost('https://other.drpc.org/key'), 'drpc')
  assert.throws(() => originHost('https://project.secret.example/key'), /operator_unknown/)
  await assert.rejects(
    () =>
      issue({
        request: req,
        clients: [clients[0], clients[0]],
        originUrls,
        dir,
        now: () => start,
        readQuote: reader(start),
      }),
    /two_origins_required/,
  )
  await assert.rejects(
    () =>
      issue({
        request: req,
        clients,
        originUrls: ['https://eth-mainnet.g.alchemy.com/x', 'https://other.g.alchemy.com/y'],
        dir,
        now: () => start,
        readQuote: reader(start),
      }),
    /two_origins_required/,
  )
  await assert.rejects(
    () =>
      issue({
        request: req,
        clients,
        originUrls,
        dir,
        now: () => start,
        readQuote: async (client, input) =>
          quote(
            input,
            start,
            client === clients[0]
              ? { status: 'success' }
              : { status: 'evm_revert', claim: '7000000' },
          ),
      }),
    /two_origin_disagreement/,
  )
  assert.equal((await verify(dir)).issues.length, 0)
  const first = await issue({
    request: req,
    clients,
    originUrls,
    dir,
    now: () => start,
    readQuote: reader(start),
  })
  const result = await score({
    issueId: first.issueId,
    horizonHours: 1,
    clients,
    originUrls,
    dir,
    now: () => start + HOUR,
    readQuote: async (client, input) =>
      quote(
        input,
        start + HOUR,
        client === clients[0] ? { status: 'success' } : { status: 'evm_revert', claim: '7000000' },
      ),
  })
  assert.equal(result.status, 'pending')
  assert.equal(result.reason, 'two_origin_disagreement')
  assert.equal((await verify(dir)).scores.length, 0)
  const expired = await score({
    issueId: first.issueId,
    horizonHours: 1,
    clients,
    originUrls,
    dir,
    now: () => start + 3 * HOUR + 1,
    readQuote: reader(start + 3 * HOUR + 1),
  })
  assert.equal(expired.outcome, 'censored')
  assert.equal(expired.censorReason, 'window_expired_after_attempts')
})

test('rehashed issue and score records with invalid measurement semantics fail replay', async (t) => {
  for (const [kind, mutate] of [
    [
      'issue',
      (x) => {
        x.baseline.claimRaw = 'bogus'
      },
    ],
    [
      'issue',
      (x) => {
        x.baseline.blockAtUtc = 'not-a-time'
      },
    ],
    [
      'issue',
      (x) => {
        x.baseline.simulation = 'unknown'
      },
    ],
    [
      'issue',
      (x) => {
        x.baseline.blockHash = '0x1234'
      },
    ],
    [
      'issue',
      (x) => {
        x.assertedOriginOperators = ['alchemy', 'alchemy']
      },
    ],
    [
      'score',
      (x) => {
        x.measurement.simulation = 'unknown'
      },
    ],
    [
      'score',
      (x) => {
        x.measurement.blockHash = '0x1234'
      },
    ],
    [
      'score',
      (x) => {
        x.measurement.claimRaw = 'nope'
      },
    ],
    [
      'score',
      (x) => {
        x.measurement.blockAtUtc = new Date(start + 4 * HOUR).toISOString()
      },
    ],
    [
      'score',
      (x) => {
        x.assertedOriginOperators = ['alchemy', 'alchemy']
      },
    ],
  ]) {
    const dir = fixture(t)
    const first = await issue({
      request: request(),
      clients,
      originUrls,
      dir,
      now: () => start,
      readQuote: reader(start),
    })
    if (kind === 'score')
      await score({
        issueId: first.issueId,
        horizonHours: 1,
        clients,
        originUrls,
        dir,
        now: () => start + HOUR,
        readQuote: reader(start + HOUR),
      })
    const subdir = kind === 'issue' ? 'issues' : 'scores'
    const path = join(dir, subdir, readdirSync(join(dir, subdir))[0])
    reseal(path, mutate)
    await assert.rejects(
      () => verify(dir),
      /requested_holder_(?:measurement|issue|score|time)_invalid/,
    )
  }
})

test('undefined owner code is unproved and chain tamper is detected', async (t) => {
  const dir = fixture(t)
  await assert.rejects(
    () =>
      issue({
        request: request(),
        clients: [{ request: async () => undefined }, clients[1]],
        originUrls,
        dir,
        now: () => start,
        readQuote: reader(start),
      }),
    /owner_code_unproved/,
  )
  const pins = []
  const pinnedClients = [0, 1].map(() => ({
    request: async (call) => {
      pins.push(call)
      return '0x'
    },
  }))
  const first = await issue({
    request: request(),
    clients: pinnedClients,
    originUrls,
    dir,
    now: () => start,
    readQuote: reader(start),
  })
  assert.equal(pins.length, 2)
  assert.ok(
    pins.every(
      (call) =>
        call.method === 'eth_getCode' &&
        call.params[0] === owner &&
        call.params[1].blockHash === hash &&
        call.params[1].requireCanonical === true,
    ),
  )
  const path = join(dir, 'issues', readdirSync(join(dir, 'issues'))[0])
  const tampered = JSON.parse(readFileSync(path, 'utf8'))
  tampered.request.assetsRaw = '1'
  writeFileSync(path, `${JSON.stringify(tampered)}\n`)
  await assert.rejects(() => verify(dir), /chain_invalid/)
  assert.ok(first.issueId)
})
