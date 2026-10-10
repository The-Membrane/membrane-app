import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalCarryExitV2NoNeonPersistence } from './localCarryExitV2NoNeonIssuer.mjs'
import { verifyLocalCarryExitV2Ledger } from './localCarryExitV2Store.mjs'
import { recordLocalCarryExitV2Readbacks } from './localCarryExitV2Witness.mjs'
import { scoreDueLocalCarryExitV2 } from './localCarryExitV2Scorer.mjs'
import { createLocalCarryExitV2Adapters } from '../research/carry-local-exit-v2-tick.mjs'
import { readLocalCarryExitV2Evidence } from '../../pages/api/carry/_lib/localCarryExitV2Read.mjs'
import {
  issueUmbrellaGhoV2Route,
  discoverUmbrellaGhoV2Candidate,
} from './carry-exit-v2-umbrella-gho-issuer.mjs'
import { umbrellaGhoFixture, umbrellaHolder } from './carry-exit-v2-umbrella-gho-fixture.mjs'
import { UMBRELLA_GHO_ROUTE } from './carry-exit-v2-umbrella-gho-proof.mjs'
import { runLocalCarryExitV2NoNeonIssueTick } from '../research/carry-local-exit-v2-no-neon-issue.mjs'
import { measureCarryExitV2Verified } from './carry-exit-v2-verified-measurement.mjs'
function pair(f) {
  const client = (url) => ({
    url,
    provider: new URL(url).origin,
    send: async (request) => f.reply(request),
    request: async (method, params) =>
      (await f.reply({ jsonrpc: '2.0', id: 1, method, params })).result,
  })
  return {
    primary: client('https://primary.example'),
    secondary: client('https://secondary.example'),
  }
}
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'umbrella-v2-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
async function issue(t, { waiting = false } = {}) {
  const f = umbrellaGhoFixture(waiting ? { end: 1791334812, revert: true } : {}),
    root = directory(t),
    now = f.args.now,
    slot = Math.floor((now().getTime() - 600000) / 900000),
    persistence = createLocalCarryExitV2NoNeonPersistence({
      source: 'umbrella_gho',
      root,
      now,
      minFreeBytes: 0,
    })
  const options = {
    ...persistence,
    ...pair(f),
    slot,
    route: UMBRELLA_GHO_ROUTE,
    now,
    assetsRaw: '2',
    discoverCandidate: (input) =>
      discoverUmbrellaGhoV2Candidate({ ...input, holders: [umbrellaHolder] }),
  }
  const result = await issueUmbrellaGhoV2Route(options)
  return { f, root, now, slot, persistence, options, result }
}
test('original-Q plan seals locally, declares snapshot window targets, and recovery starts zero RPC', async (t) => {
  const x = await issue(t, { waiting: true })
  assert.equal(x.result.status, 'issued')
  const state = verifyLocalCarryExitV2Ledger({ root: x.root }),
    record = [...state.issues.values()][0]
  assert.equal(record.payload.assetsRaw, '2')
  assert.equal(record.payload.baselineStatus, 'inconclusive')
  assert.equal(record.payload.issueEnvelope.caseClassification.inconclusiveReason, 'waiting')
  assert.deepEqual(
    record.payload.plan.map((p) => p.horizonH),
    [1, 2, 4, 24, 48, 49, 168],
  )
  const starts = x.f.calls.length
  const recovered = await issueUmbrellaGhoV2Route({
    ...x.options,
    captureBaseline: () => {
      throw Error('must_not_probe')
    },
  })
  assert.equal(recovered.status, 'issued_recovered')
  assert.equal(x.f.calls.length, starts)
  const result = await runLocalCarryExitV2NoNeonIssueTick({
    root: x.root,
    now: x.now,
    minFreeBytes: 0,
    clients: [x.options.primary, x.options.secondary],
    verificationUrl: '',
    sourcePreparation: { enabled: false },
    chooseMorphoOrigin: async (urls, _route, transport) => transport(urls[0]),
    chooseDirectOrigin: async (urls, _route, transport) => transport(urls[0]),
    issueMorpho: async () => ({ status: 'fixture' }),
    issueDirect: async () => ({ status: 'fixture' }),
    issueSyncVault: async () => ({ status: 'fixture' }),
    issueUmbrellaGho: () => {
      throw Error('sealed_issuer_must_not_run')
    },
  })
  assert.equal(
    result.results.find((row) => row.family === 'umbrella_gho').status,
    'issued_recovered',
  )
  assert.equal(x.f.calls.length, starts)
})
test('covered waiting baseline is re-observed and becomes eligible at H1 with recalculated shares', async (t) => {
  const x = await issue(t, { waiting: true })
  assert.equal(x.result.status, 'issued')
  recordLocalCarryExitV2Readbacks({
    root: x.root,
    now: () => new Date(x.now().getTime() + 60000),
    minFreeBytes: 0,
  })
  const future = umbrellaGhoFixture({
    seconds: 1791334824,
    end: 1791334812,
    required: 7n,
    blockNumber: 401,
    hash: `0x${'e'.repeat(64)}`,
    parentHash: x.f.target.targetHash,
  })
  const target = future.target,
    clock = future.args.now,
    clients = pair(future)
  target.canonicalityEvidenceDoc.targetAt = new Date(x.now().getTime() + 3600000).toISOString()
  target.canonicalityEvidenceDoc.baselineHeader = x.f.target.canonicalityEvidenceDoc.baselineHeader
  const adapters = createLocalCarryExitV2Adapters({
    ...clients,
    now: clock,
    select: async () => target,
  })
  const result = await scoreDueLocalCarryExitV2({
    root: x.root,
    now: clock,
    adapters,
    minFreeBytes: 0,
  })
  assert.equal(result.counts.success, 1)
  const state = verifyLocalCarryExitV2Ledger({ root: x.root }),
    score = [...state.outcomes.values()][0]
  assert.equal(score.payload.scoreEnvelope.assetsRaw, '2')
  assert.equal(score.payload.scoreEnvelope.classification.requiredCoverageRaw, '7')
  const observed = readLocalCarryExitV2Evidence(
    { ...UMBRELLA_GHO_ROUTE, decimals: 18, assetsRaw: '2', horizonH: 1 },
    { root: x.root },
  )
  assert.equal(observed.status, 'collecting')
  assert.equal(observed.evidence.measured, 1)
  assert.equal(observed.evidence.recordedUnverified, 0)
})
test('physical request cap includes seed screening, capture and both replay origins', async (t) => {
  const f = umbrellaGhoFixture(),
    root = directory(t),
    now = f.args.now,
    persistence = createLocalCarryExitV2NoNeonPersistence({
      source: 'umbrella_gho',
      root,
      now,
      minFreeBytes: 0,
    })
  let starts = 0
  const clients = pair(f)
  clients.primary.request = async () => {
    starts++
    return '0x1'
  }
  const result = await issueUmbrellaGhoV2Route({
    ...persistence,
    ...clients,
    slot: Math.floor((now().getTime() - 600000) / 900000),
    now,
    captureBaseline: async ({ request }) => {
      for (let i = 0; i < 257; i++) await request('eth_chainId', [])
      throw Error('must_not_reach')
    },
  })
  assert.equal(result.reason, 'issuer_rpc_start_limit')
  assert.equal(starts, 256)
})
test('late baseline completion cannot discover a holder or seal an episode', async (t) => {
  const f = umbrellaGhoFixture(),
    root = directory(t)
  let current = f.args.now().getTime()
  const now = () => new Date(current),
    persistence = createLocalCarryExitV2NoNeonPersistence({
      source: 'umbrella_gho',
      root,
      now,
      minFreeBytes: 0,
    }),
    clients = pair(f)
  clients.primary.request = async () => {
    current += 241000
    return '0x1'
  }
  const result = await issueUmbrellaGhoV2Route({
    ...persistence,
    ...clients,
    slot: Math.floor((current - 600000) / 900000),
    now,
    captureBaseline: async ({ request }) => {
      await request('eth_chainId', [])
      throw Error('must_not_reach')
    },
    discoverCandidate: () => {
      throw Error('must_not_discover')
    },
  })
  assert.equal(result.reason, 'issuer_deadline_elapsed')
  assert.equal(verifyLocalCarryExitV2Ledger({ root }).issues.size, 0)
})
test('fourth runner source retries configured primary and keeps designated independent verifier', async (t) => {
  const root = directory(t),
    f = umbrellaGhoFixture(),
    now = f.args.now,
    clients = pair(f)
  const first = {
    ...clients.primary,
    url: 'https://bad.example',
    provider: 'https://bad.example',
    request: async () => {
      throw Error('offline')
    },
  }
  const preferred = {
    ...clients.secondary,
    url: 'https://verify.example',
    provider: 'https://verify.example',
  }
  const captureBaseline = async ({ routeKey, destination, asset }) => ({
    routeKey,
    destination,
    asset,
    targetBlock: '400',
  })
  const discoverCandidate = async () => ({ holder: umbrellaHolder, evidenceDoc: {} })
  let selected = null
  const result = await runLocalCarryExitV2NoNeonIssueTick({
    root,
    now,
    minFreeBytes: 0,
    clients: [first, clients.primary, preferred],
    verificationUrl: preferred.url,
    chooseMorphoOrigin: async (urls, _route, transport) => transport(urls[0]),
    chooseDirectOrigin: async (urls, _route, transport) => transport(urls[0]),
    sourcePreparation: {
      enabled: true,
      morpho: { captureBaseline, discoverCandidate },
      direct: { captureBaseline, discoverCandidate },
      syncVault: {
        captureBaseline,
        discoverCandidate,
        chooseOrigin: async (urls, _route, transport) => transport(urls[0]),
      },
      umbrellaGho: {
        captureBaseline: async (input) => {
          await input.request('eth_chainId', [])
          return captureBaseline(input)
        },
        discoverCandidate,
      },
    },
    issueMorpho: async () => ({ status: 'fixture' }),
    issueDirect: async () => ({ status: 'fixture' }),
    issueSyncVault: async () => ({ status: 'fixture' }),
    issueUmbrellaGho: async (input) => {
      selected = input
      return { status: 'fixture' }
    },
  })
  assert.equal(selected.primary.url, clients.primary.url)
  assert.equal(selected.secondary.url, preferred.url)
  assert.equal((await selected.captureBaseline()).destination, UMBRELLA_GHO_ROUTE.destination)
  assert.equal(result.routeCounts.umbrellaGho, 1)
})

async function budgetFixture(t) {
  const f = umbrellaGhoFixture(),
    root = directory(t),
    now = f.args.now
  const clients = pair(f)
  const baseline = { ...f.target, ...UMBRELLA_GHO_ROUTE, assetDecimals: 18, shareDecimals: 18 }
  const candidate = await discoverUmbrellaGhoV2Candidate({
    baseline,
    request: clients.primary.request,
    assetsRaw: '2',
    holders: [umbrellaHolder],
  })
  const verified = await measureCarryExitV2Verified({
    ...f.args,
    primary: { url: clients.primary.url, request: clients.primary.send },
    secondary: { url: clients.secondary.url, request: clients.secondary.send },
  })
  assert.equal(verified.status, 'verified')
  f.calls.length = 0
  return {
    f,
    root,
    clients,
    baseline,
    candidate,
    verified,
    options: {
      ...createLocalCarryExitV2NoNeonPersistence({
        source: 'umbrella_gho',
        root,
        now,
        minFreeBytes: 0,
      }),
      ...clients,
      now,
      assetsRaw: '2',
      slot: Math.floor((now().getTime() - 600000) / 900000),
      captureBaseline: async () => baseline,
      discoverCandidate: async () => candidate,
    },
  }
}

test('real collector swallowing attempted start 257 retains issuer cap reason after baseline 255', async (t) => {
  const x = await budgetFixture(t)
  let helperReason
  const result = await issueUmbrellaGhoV2Route({
    ...x.options,
    captureBaseline: async ({ request }) => {
      for (let i = 0; i < 255; i++) await request('eth_chainId', [])
      return x.baseline
    },
    measure: async (input) => {
      const result = await measureCarryExitV2Verified(input)
      helperReason = result.reason
      return result
    },
  })
  assert.equal(helperReason, 'collection_failed')
  assert.equal(result.reason, 'issuer_rpc_start_limit')
  assert.equal(x.f.calls.length, 256)
  assert.equal(verifyLocalCarryExitV2Ledger({ root: x.root }).issues.size, 0)
})

test('a verified final permitted start 256 seals without falsely declaring exhaustion', async (t) => {
  const x = await budgetFixture(t)
  const result = await issueUmbrellaGhoV2Route({
    ...x.options,
    captureBaseline: async ({ request }) => {
      for (let i = 0; i < 255; i++) await request('eth_chainId', [])
      return x.baseline
    },
    measure: async ({ send }) => {
      await send({ jsonrpc: '2.0', id: 'last', method: 'eth_chainId', params: [] })
      return x.verified
    },
  })
  assert.equal(result.status, 'issued')
  assert.equal(x.f.calls.length, 256)
  assert.equal(verifyLocalCarryExitV2Ledger({ root: x.root }).issues.size, 1)
})

test('real seed discovery swallowing a late response retains issuer deadline reason', async (t) => {
  const x = await budgetFixture(t)
  let time = x.options.now().getTime(),
    candidateReason
  x.clients.primary.request = async () => {
    time += 241000
    return '0x'
  }
  const result = await issueUmbrellaGhoV2Route({
    ...x.options,
    ...x.clients,
    now: () => new Date(time),
    discoverCandidate: async (input) => {
      const candidate = await discoverUmbrellaGhoV2Candidate({
        ...input,
        holders: [umbrellaHolder],
      })
      candidateReason = candidate.evidenceDoc.unavailableReason
      return candidate
    },
  })
  assert.equal(candidateReason, 'no_original_gho_q_holder_in_bounded_seed')
  assert.equal(result.reason, 'issuer_deadline_elapsed')
})

test('real seed discovery swallowing attempted start 257 retains issuer cap reason', async (t) => {
  const x = await budgetFixture(t)
  const result = await issueUmbrellaGhoV2Route({
    ...x.options,
    captureBaseline: async ({ request }) => {
      for (let i = 0; i < 256; i++) await request('eth_chainId', [])
      return x.baseline
    },
    discoverCandidate: (input) =>
      discoverUmbrellaGhoV2Candidate({ ...input, holders: [umbrellaHolder] }),
  })
  assert.equal(result.reason, 'issuer_rpc_start_limit')
  assert.equal(x.f.calls.length, 256)
})

async function nativeBudgetRun(
  t,
  { late = false, exactLast = false, callerDeadlineMs = null, wallDeadlineMs = null } = {},
) {
  const x = await budgetFixture(t)
  let time = x.options.now().getTime(),
    enteredIssuer = false
  const bad = {
    ...x.clients.primary,
    url: 'https://bad.example',
    provider: 'https://bad.example',
    request: async () => {
      x.f.calls.push('bad')
      throw Error('offline')
    },
  }
  const captureBaseline = async (input) => ({
    ...input,
    ...x.baseline,
    routeKey: input.routeKey,
    destination: input.destination,
    asset: input.asset,
  })
  const discoverCandidate = async () => x.candidate
  const result = await runLocalCarryExitV2NoNeonIssueTick({
    root: x.root,
    now: () => new Date(time),
    minFreeBytes: 0,
    clients: [bad, x.clients.primary, x.clients.secondary],
    verificationUrl: x.clients.secondary.url,
    deadlineMs: callerDeadlineMs,
    wallDeadlineMs,
    chooseMorphoOrigin: async (urls, _route, transport) => transport(urls[0]),
    chooseDirectOrigin: async (urls, _route, transport) => transport(urls[0]),
    sourcePreparation: {
      enabled: true,
      morpho: { captureBaseline, discoverCandidate },
      direct: { captureBaseline, discoverCandidate },
      syncVault: {
        captureBaseline,
        discoverCandidate,
        chooseOrigin: async (urls, _route, transport) => transport(urls[0]),
      },
      umbrellaGho: {
        captureBaseline: async (input) => {
          if (input.provider === bad.provider) await input.request('eth_chainId', [])
          if (late) {
            time += 91000
            return captureBaseline(input)
          }
          for (let i = 0; i < 254; i++) await input.request('eth_chainId', [])
          return captureBaseline(input)
        },
        discoverCandidate,
      },
    },
    issueMorpho: async () => ({ status: 'fixture' }),
    issueDirect: async () => ({ status: 'fixture' }),
    issueSyncVault: async () => ({ status: 'fixture' }),
    issueUmbrellaGho: async (input) => {
      enteredIssuer = true
      return issueUmbrellaGhoV2Route({
        ...input,
        assetsRaw: '2',
        ...(exactLast
          ? {
              measure: async ({ send }) => {
                await send({ jsonrpc: '2.0', id: 'last', method: 'eth_chainId', params: [] })
                return x.verified
              },
            }
          : {}),
      })
    },
  })
  return { x, enteredIssuer, result: result.results.find((row) => row.family === 'umbrella_gho') }
}

test('native preparation and failover share the issuer cap without resetting or double counting', async (t) => {
  const { x, result, enteredIssuer } = await nativeBudgetRun(t)
  assert.equal(enteredIssuer, true)
  assert.equal(result.reason, 'issuer_rpc_start_limit')
  assert.equal(x.f.calls.length, 256)
})

test('native preparation permits start 256 to produce the final verified issue', async (t) => {
  const { x, result } = await nativeBudgetRun(t, { exactLast: true })
  assert.equal(result.status, 'issued')
  assert.equal(x.f.calls.length, 256)
})

test('native preparation swallowing its 90-second deadline is typed before invoking issuer', async (t) => {
  const { result, enteredIssuer } = await nativeBudgetRun(t, { late: true })
  assert.equal(enteredIssuer, false)
  assert.equal(result.reason, 'issuer_deadline_elapsed')
})

test('native preparation honors an earlier caller deadline', async (t) => {
  const start = umbrellaGhoFixture().args.now().getTime()
  const { result, enteredIssuer } = await nativeBudgetRun(t, { callerDeadlineMs: start - 1 })
  assert.equal(enteredIssuer, false)
  assert.equal(result.reason, 'issuer_deadline_elapsed')
})

test('native preparation honors an earlier caller wall deadline', async (t) => {
  const { result, enteredIssuer } = await nativeBudgetRun(t, { wallDeadlineMs: Date.now() - 1 })
  assert.equal(enteredIssuer, false)
  assert.equal(result.reason, 'issuer_deadline_elapsed')
})
