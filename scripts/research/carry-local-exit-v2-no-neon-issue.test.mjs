import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CARRY_EXIT_V2_FROZEN_ROUTES } from '../lib/carry-exit-v2-rpc-proof.mjs'
import {
  createLocalCarryExitV2NoNeonPersistence,
  hashLocalCarryExitV2Json,
  localCarryExitV2EpisodeId,
  localCarryExitV2NativeSlotAt,
} from '../lib/localCarryExitV2NoNeonIssuer.mjs'
import {
  appendLocalCarryExitV2Record,
  verifyLocalCarryExitV2Ledger,
} from '../lib/localCarryExitV2Store.mjs'
import { issueDirectV2Route } from '../record-carry-direct-exit-v2-issues.mjs'
import { issueMorphoV2Route } from '../record-carry-morpho-exit-v2-issues.mjs'
import { issueSyncVaultV2Route } from '../record-carry-sync-vault-exit-v2-issues.mjs'
import {
  configuredLocalCarryExitV2NoNeonRpcUrlsWithVerification,
  localCarryExitV2NoNeonRoster,
  recordLocalCarryExitV2HistoricalDenominator,
  runLocalCarryExitV2NoNeonIssueTick as runFourSourceIssueTick,
  selectLocalCarryExitV2NoNeonOriginPair,
  selectLocalCarryExitV2NoNeonRoutes,
} from './carry-local-exit-v2-no-neon-issue.mjs'

// Existing three-source transport fixtures remain scoped to their original families.
const legacyRegistry = CARRY_EXIT_V2_FROZEN_ROUTES.filter((route) => route.kind !== 'umbrella_gho')
const runLocalCarryExitV2NoNeonIssueTick = (options) =>
  runFourSourceIssueTick({ registry: legacyRegistry, ...options })
const at = '2026-10-07T12:11:00.000Z'
const now = () => new Date(at)
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function rootFor(t) {
  const directory = mkdtempSync(join(tmpdir(), 'carry-exit-v2-no-neon-tick-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return join(directory, 'ledger')
}

function baseline(route) {
  return {
    routeKey: route.routeKey,
    destination: route.destination,
    asset: route.asset,
    assetDecimals: 18,
    targetBlock: '24000000',
    targetHash: `0x${'a'.repeat(64)}`,
    targetBlockAt: '2026-10-07T12:10:10.000Z',
    targetObservedAt: '2026-10-07T12:10:20.000Z',
    canonicalityEvidenceDoc: {
      schema: 'finalized_baseline_v1',
      targetHash: `0x${'a'.repeat(64)}`,
    },
  }
}

function candidate() {
  const evidenceDoc = {
    schema: 'issuer_candidate_v1',
    ladder: {
      labels: Array.from({ length: 6 }, (_, index) => ({
        label: `q${index + 1}`,
        assetsRaw: String(index + 1),
        reason: null,
      })),
    },
  }
  return {
    holder: `0x${'b'.repeat(40)}`,
    digest: sha(evidenceDoc),
    evidenceDoc,
  }
}

function sealedPlan(route, slot) {
  const slotAt = localCarryExitV2NativeSlotAt(slot)
  const slotMs = Date.parse(slotAt)
  const candidateDoc = { schema: 'local_candidate_v1', routeKey: route.routeKey }
  const callDoc = { schema: 'local_call_v1', result: '0x01' }
  return {
    version: 'carry_exit_v2',
    clock: 'local_operator_clock',
    endpointSelection: 'first_finalized_at_or_after_target',
    captureDeadlineHours: 2,
    horizons: [1, 4, 24, 48, 168],
    routeKey: route.routeKey,
    slotAt,
    destination: route.destination,
    asset: route.asset,
    assetDecimals: 18,
    holder: `0x${'c'.repeat(40)}`,
    baselineBlock: String(24_000_000 + (slot % 10_000)),
    baselineHash: `0x${'d'.repeat(64)}`,
    baselineBlockAt: new Date(slotMs + 10_000).toISOString(),
    baselineObservedAt: new Date(slotMs + 20_000).toISOString(),
    candidateProvenance: 'receipt_verified_transfer',
    candidateEvidenceSha256: hashLocalCarryExitV2Json(candidateDoc),
    candidateEvidenceDoc: candidateDoc,
    canonicalityEvidenceDoc: { finalized: true, blockHash: `0x${'d'.repeat(64)}` },
    omittedLadder: [],
    cases: [
      {
        assetsRaw: '1000000000000000000',
        baselineStatus: 'success',
        coverageKind: 'assets',
        holderCoverageRaw: '2000000000000000000',
        requiredCoverageRaw: '1000000000000000000',
        actualConsumedRaw: null,
        simulationStatus: 'success',
        callEvidenceSha256: hashLocalCarryExitV2Json(callDoc),
        callEvidenceDoc: callDoc,
        entitlementEvidenceSha256: null,
        entitlementEvidenceDoc: null,
        inconclusiveReason: null,
        unavailableReason: null,
      },
      {
        assetsRaw: '2000000000000000000',
        baselineStatus: 'unavailable',
        coverageKind: null,
        holderCoverageRaw: null,
        requiredCoverageRaw: null,
        actualConsumedRaw: null,
        simulationStatus: null,
        callEvidenceSha256: null,
        callEvidenceDoc: null,
        entitlementEvidenceSha256: null,
        entitlementEvidenceDoc: null,
        inconclusiveReason: null,
        unavailableReason: 'fixture_unavailable',
      },
    ],
  }
}

function client(url) {
  return {
    url,
    provider: new URL(url).origin,
    async request() {
      throw Error('unexpected_rpc_request')
    },
    async send() {
      throw Error('unexpected_rpc_send')
    },
  }
}

function persistenceOptions(persistence) {
  return {
    sql: persistence.sql,
    appendAttempt: persistence.appendAttempt,
    persist: persistence.persist,
    hashEvidence: persistence.hashEvidence,
    recordDbAttempt: persistence.recordDbAttempt,
    recoverIssuedBatch: persistence.recoverIssuedBatch,
    recoverIssuedSlotBatch: persistence.recoverIssuedSlotBatch,
    recordLocalIssues: persistence.recordLocalIssues,
  }
}

test('the actual :15/:45 cadence traverses all 80 frozen tuples in one rotation cycle', () => {
  const roster = localCarryExitV2NoNeonRoster()
  assert.deepEqual(
    {
      morpho: roster.morpho.length,
      direct: roster.direct.length,
      syncVault: roster.syncVault.length,
    },
    { morpho: 68, direct: 4, syncVault: 8 },
  )
  const seen = { morpho: new Set(), direct: new Set(), syncVault: new Set() }
  const cadenceStart = Date.parse('2026-10-07T00:15:00.000Z')
  let first = null
  let previous = null
  let sawSgho = false
  for (let tick = 0; tick < 136; tick++) {
    const selected = selectLocalCarryExitV2NoNeonRoutes(cadenceStart + tick * 30 * 60_000)
    first ??= selected
    if (previous) {
      assert.equal(selected.slot, previous.slot + 2)
      assert.equal(selected.rotationIndex, previous.rotationIndex + 1)
    }
    for (const family of Object.keys(seen))
      seen[family].add(
        `${selected[family].routeKey}\u0000${selected[family].destination}\u0000${selected[family].asset}`,
      )
    sawSgho ||= selected.syncVault.kind === 'sgho'
    previous = selected
  }
  assert.equal(seen.morpho.size, roster.morpho.length)
  assert.equal(seen.direct.size, roster.direct.length)
  assert.equal(seen.syncVault.size, roster.syncVault.length)
  assert.ok([...seen.direct].some((key) => key.startsWith('USDe → supply on Aave V3\u0000')))
  assert.equal(sawSgho, true)

  const repeated = selectLocalCarryExitV2NoNeonRoutes(cadenceStart + 136 * 30 * 60_000)
  for (const family of Object.keys(seen))
    assert.equal(
      `${repeated[family].routeKey}\u0000${repeated[family].destination}\u0000${repeated[family].asset}`,
      `${first[family].routeKey}\u0000${first[family].destination}\u0000${first[family].asset}`,
    )
})

test('origin selection never treats two URLs on one host as independent', () => {
  const primary = client('https://rpc.example/a')
  const sameHost = client('https://rpc.example/b')
  const independent = client('https://other.example/rpc')
  assert.deepEqual(selectLocalCarryExitV2NoNeonOriginPair({ clients: [primary, sameHost] }), {
    primary,
    secondary: null,
  })
  assert.deepEqual(
    selectLocalCarryExitV2NoNeonOriginPair({ clients: [primary, sameHost, independent] }),
    { primary, secondary: independent },
  )
})

test('origin construction passes only the URL to transports with a default fetch seam', () => {
  const calls = []
  const transport = (url, fetchImpl = fetch) => {
    calls.push({ url, fetchImpl })
    return client(url)
  }
  const pair = selectLocalCarryExitV2NoNeonOriginPair({
    urls: 'https://primary.example/rpc,https://secondary.example/rpc',
    transport,
  })
  assert.equal(calls.length, 2)
  assert.ok(calls.every((call) => call.fetchImpl === fetch))
  assert.equal(pair.primary.url, 'https://primary.example/rpc')
  assert.equal(pair.secondary.url, 'https://secondary.example/rpc')
})

test('CLI RPC configuration adds an independent verification origin and rejects same-origin pairs', () => {
  const fallback = configuredLocalCarryExitV2NoNeonRpcUrlsWithVerification({
    urls: 'https://primary.example/rpc',
  })
  assert.equal(fallback.length, 2)
  const pair = selectLocalCarryExitV2NoNeonOriginPair({ urls: fallback, transport: client })
  assert.equal(pair.primary.url, 'https://primary.example/rpc')
  assert.equal(pair.secondary.url, 'https://eth.drpc.org')
  assert.deepEqual(
    configuredLocalCarryExitV2NoNeonRpcUrlsWithVerification({
      urls: 'https://primary.example/rpc',
      verificationUrl: 'https://primary.example/verify',
    }),
    ['https://primary.example/rpc'],
  )
  assert.deepEqual(
    configuredLocalCarryExitV2NoNeonRpcUrlsWithVerification({
      urls: 'https://primary.example/rpc,https://raw-secondary.example/rpc',
      verificationUrl: 'https://secondary.example/verify',
    }),
    [
      'https://primary.example/rpc',
      'https://secondary.example/verify',
      'https://raw-secondary.example/rpc',
    ],
  )
})

test('replay prefers the designated verification URL relative to the selected primary', () => {
  const first = client('https://first.example/rpc')
  const primary = client('https://selected.example/rpc')
  const verification = client('https://first.example/verify')
  const sameHost = client('https://selected.example/other')
  const clients = [first, sameHost, primary, verification]
  assert.deepEqual(
    selectLocalCarryExitV2NoNeonOriginPair({
      clients,
      primary,
      verificationUrl: verification.url,
    }),
    { primary, secondary: verification },
  )
  assert.deepEqual(
    selectLocalCarryExitV2NoNeonOriginPair({
      clients: [sameHost, primary],
      primary,
      verificationUrl: sameHost.url,
    }),
    { primary, secondary: null },
  )
  assert.deepEqual(
    selectLocalCarryExitV2NoNeonOriginPair({
      clients,
      primary,
      verificationUrl: sameHost.url,
    }),
    { primary, secondary: first },
  )
})

test('family selectors skip a ten-block endpoint and pass the capable configured primary to issuance', async (t) => {
  const root = rootFor(t)
  // The verification URL shares the rejected first host; independence must
  // therefore be evaluated after the capable backup becomes primary.
  const bad = client('https://verification.example/limited')
  const good = client('https://capable.example/rpc')
  const verification = client('https://verification.example/rpc')
  const probes = []
  for (const endpoint of [bad, good])
    endpoint.request = async (method, params) => {
      probes.push({ url: endpoint.url, method, params })
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') return { number: '0x10000' }
      assert.equal(method, 'eth_getLogs')
      const span = BigInt(params[0].toBlock) - BigInt(params[0].fromBlock) + 1n
      assert.equal(span, 32n)
      if (endpoint === bad && span > 10n) throw Error('log_range_exceeds_ten_blocks')
      return []
    }
  const calls = []
  const issuer = (family) => async (options) => {
    calls.push({ family, primary: options.primary?.url, secondary: options.secondary?.url })
    return { status: 'unavailable', reason: 'fixture' }
  }
  const result = await runLocalCarryExitV2NoNeonIssueTick({
    sourcePreparation: { enabled: false },
    root,
    now,
    minFreeBytes: 0,
    clients: [bad, good],
    verificationUrl: verification.url,
    transport: (url) => {
      assert.equal(url, verification.url)
      return verification
    },
    issueMorpho: issuer('morpho'),
    issueDirect: issuer('direct'),
    issueSyncVault: issuer('sync_vault'),
  })
  assert.deepEqual(calls, [
    { family: 'morpho', primary: good.url, secondary: verification.url },
    { family: 'direct', primary: good.url, secondary: verification.url },
    { family: 'sync_vault', primary: bad.url, secondary: good.url },
  ])
  assert.equal(probes.filter((probe) => probe.url === bad.url).length, 6)
  assert.equal(probes.filter((probe) => probe.url === good.url).length, 7)
  assert.equal(probes.filter((probe) => probe.url === verification.url).length, 0)
  assert.equal(result.originCount, 2)
})

test('no log-capable configured primary records typed unavailable attempts', async (t) => {
  const root = rootFor(t)
  const limited = client('https://limited.example/rpc')
  let probes = 0
  limited.request = async (method) => {
    probes++
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getBlockByNumber') return { number: '0x10000' }
    throw Error('log_range_unavailable')
  }
  const result = await runLocalCarryExitV2NoNeonIssueTick({
    sourcePreparation: { enabled: false },
    root,
    now,
    minFreeBytes: 0,
    clients: [limited],
    verificationUrl: '',
    issueSyncVault: async () => ({ status: 'unavailable', reason: 'fixture' }),
  })
  assert.equal(probes, 6)
  for (const family of ['morpho', 'direct']) {
    const row = result.results.find((entry) => entry.family === family)
    assert.equal(row.status, 'unavailable')
    assert.equal(row.reason, 'primary_rpc_unavailable')
  }
  const state = verifyLocalCarryExitV2Ledger({ root })
  assert.equal(state.issues.size, 0)
  assert.equal(
    [...state.attempts.values()].filter(
      (row) => row.payload.attemptEnvelope?.issuerAttempt.reason === 'primary_rpc_unavailable',
    ).length,
    2,
  )
})

test('probe time consumes the same family budget as subsequent issuance RPC', async (t) => {
  const root = rootFor(t)
  let clockMs = Date.parse(at)
  const endpoint = client('https://primary.example/rpc')
  let requests = 0
  endpoint.request = async () => {
    requests++
    return '0x1'
  }
  const choose = async (urls, route, transport, deadlineMs) => {
    assert.ok(deadlineMs <= Date.now() + 4 * 60_000)
    const selected = transport(urls[0])
    await selected.request('eth_chainId', [])
    clockMs += 3 * 60_000
    return selected
  }
  const result = await runLocalCarryExitV2NoNeonIssueTick({
    sourcePreparation: { enabled: false },
    root,
    now: () => new Date(clockMs),
    minFreeBytes: 0,
    clients: [endpoint],
    verificationUrl: '',
    chooseMorphoOrigin: choose,
    chooseDirectOrigin: async () => null,
    issueMorpho: async ({ primary }) => {
      clockMs += 60_001
      await assert.rejects(() => primary.request('eth_chainId', []), /issuer_deadline_elapsed/)
      await assert.rejects(() => primary.send({}), /issuer_deadline_elapsed/)
      return { status: 'unavailable', reason: 'fixture_deadline' }
    },
    issueDirect: async () => ({ status: 'unavailable', reason: 'fixture' }),
    issueSyncVault: async () => ({ status: 'unavailable', reason: 'fixture' }),
  })
  assert.equal(requests, 1)
  assert.equal(result.results[0].reason, 'fixture_deadline')
})

test('full preparation fails over as one provider unit and the issuer reuses its cached scan', async (t) => {
  const root = rootFor(t)
  const bad = client('https://bad.example/rpc')
  const backup = client('https://backup.example/rpc')
  const verification = client('https://verify.example/rpc')
  const seen = []
  const scanCalls = []
  const choose = async (urls, _route, transport) => transport(urls[0])
  const captureBaseline = async ({ routeKey, destination, asset, provider, request }) => {
    scanCalls.push({ stage: 'baseline', destination, provider })
    await request('eth_getBlockByNumber', ['finalized', false])
    return { routeKey, destination, asset, provider, targetBlock: '10' }
  }
  const discoverCandidate = async ({ baseline: row, request }) => {
    scanCalls.push({ stage: 'candidate', destination: row.destination, provider: row.provider })
    await request('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x9' }])
    if (
      row.destination === selection.direct.destination &&
      row.provider === new URL(bad.url).origin
    )
      throw Error('candidate_log_throttle_exhausted')
    const result = { ...candidate(), provider: row.provider }
    return result
  }
  const selection = selectLocalCarryExitV2NoNeonRoutes(Date.parse(at))
  bad.request = async () => ({ ok: 'bad' })
  backup.request = async () => ({ ok: 'backup' })
  const issueMorpho = async (options) => {
    seen.push({
      family: 'morpho',
      baseline: await options.captureBaseline(),
      candidate: await options.discoverCandidate(),
    })
    return { status: 'fixture' }
  }
  const issueDirect = async (options) => {
    seen.push({
      family: 'direct',
      primary: options.primary.url,
      secondary: options.secondary?.url,
      baseline: await options.captureBaseline(),
      candidate: await options.discoverCandidate(),
    })
    return { status: 'fixture' }
  }
  const issueSyncVault = async (options) => {
    seen.push({ family: 'sync_vault', provider: options.preflight?.baseline?.provider ?? null })
    return { status: 'fixture' }
  }
  await runLocalCarryExitV2NoNeonIssueTick({
    root,
    now,
    minFreeBytes: 0,
    clients: [bad, backup],
    verificationUrl: verification.url,
    transport: () => verification,
    chooseMorphoOrigin: choose,
    chooseDirectOrigin: choose,
    sourcePreparation: {
      enabled: true,
      morpho: { captureBaseline, discoverCandidate },
      direct: { captureBaseline, discoverCandidate },
      syncVault: { captureBaseline, discoverCandidate, chooseOrigin: choose },
    },
    issueMorpho,
    issueDirect,
    issueSyncVault,
  })
  const direct = seen.find((row) => row.family === 'direct')
  assert.equal(direct.primary, backup.url)
  assert.equal(direct.secondary, verification.url)
  assert.equal(direct.baseline.provider, new URL(backup.url).origin)
  assert.equal(direct.candidate.provider, new URL(backup.url).origin)
  assert.deepEqual(
    seen.filter((row) => row.family === 'direct').map((row) => row.candidate.provider),
    [new URL(backup.url).origin],
  )
  assert.deepEqual(
    scanCalls.filter((row) => row.destination === selection.direct.destination),
    [
      {
        stage: 'baseline',
        destination: selection.direct.destination,
        provider: new URL(bad.url).origin,
      },
      {
        stage: 'candidate',
        destination: selection.direct.destination,
        provider: new URL(bad.url).origin,
      },
      {
        stage: 'baseline',
        destination: selection.direct.destination,
        provider: new URL(backup.url).origin,
      },
      {
        stage: 'candidate',
        destination: selection.direct.destination,
        provider: new URL(backup.url).origin,
      },
    ],
  )
})

test('a deadline exhausted during one provider scan stops fallback before another origin starts', async (t) => {
  const root = rootFor(t)
  let clockMs = Date.parse(at)
  const first = client('https://first.example/rpc')
  const second = client('https://second.example/rpc')
  let secondStarted = false
  const choose = async (urls, _route, transport) => {
    if (urls[0] === second.url) secondStarted = true
    return transport(urls[0])
  }
  const captureBaseline = async ({ routeKey, destination, asset, request }) => {
    await request('eth_getBlockByNumber', ['finalized', false])
    return { routeKey, destination, asset, targetBlock: '10' }
  }
  const discoverCandidate = async ({ request }) => {
    await request('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x9' }])
    clockMs += 5 * 60_000
    throw Error('candidate_log_throttle_exhausted')
  }
  first.request = second.request = async () => '0x1'
  const result = await runLocalCarryExitV2NoNeonIssueTick({
    root,
    now: () => new Date(clockMs),
    minFreeBytes: 0,
    clients: [first, second],
    verificationUrl: '',
    chooseMorphoOrigin: choose,
    sourcePreparation: {
      enabled: true,
      morpho: { captureBaseline, discoverCandidate },
      direct: { captureBaseline, discoverCandidate },
      syncVault: { captureBaseline, discoverCandidate, chooseOrigin: choose },
    },
    issueMorpho: async () => ({ status: 'must_not_issue' }),
    issueDirect: async () => ({ status: 'must_not_issue' }),
    issueSyncVault: async () => ({ status: 'must_not_issue' }),
  })
  assert.equal(secondStarted, false)
  assert.equal(result.results[0].reason, 'issuer_deadline_elapsed')
})

test('provider slice expiry falls back while the shared family deadline still has time', async (t) => {
  const root = rootFor(t)
  let clockMs = Date.parse(at)
  const first = client('https://first.example/rpc')
  const backup = client('https://backup.example/rpc')
  const selection = selectLocalCarryExitV2NoNeonRoutes(clockMs)
  let backupCandidateCompleted = false
  const choose = async (urls, _route, transport) => transport(urls[0])
  const captureBaseline = async ({ routeKey, destination, asset, provider, request }) => {
    await request('eth_getBlockByNumber', ['finalized', false])
    return { routeKey, destination, asset, provider, targetBlock: '10' }
  }
  const discoverCandidate = async ({ baseline: row, request }) => {
    await request('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x9' }])
    if (
      row.destination === selection.morpho.destination &&
      row.provider === new URL(first.url).origin
    ) {
      clockMs += 121_000
      throw Error('candidate_scan_timeout')
    }
    backupCandidateCompleted = true
    return candidate()
  }
  first.request = backup.request = async () => '0x1'
  let selectedPrimary = null
  const result = await runLocalCarryExitV2NoNeonIssueTick({
    root,
    now: () => new Date(clockMs),
    minFreeBytes: 0,
    clients: [first, backup],
    verificationUrl: '',
    chooseMorphoOrigin: choose,
    chooseDirectOrigin: choose,
    sourcePreparation: {
      enabled: true,
      morpho: { captureBaseline, discoverCandidate },
      direct: { captureBaseline, discoverCandidate },
      syncVault: { captureBaseline, discoverCandidate, chooseOrigin: choose },
    },
    issueMorpho: async ({ primary }) => {
      selectedPrimary = primary.url
      return { status: 'fixture' }
    },
    issueDirect: async () => ({ status: 'fixture' }),
    issueSyncVault: async () => ({ status: 'fixture' }),
  })
  assert.equal(backupCandidateCompleted, true)
  assert.equal(selectedPrimary, backup.url)
  assert.equal(result.results[0].reason, undefined)
})

test('a successful candidate returned after its provider slice expires is discarded', async (t) => {
  const root = rootFor(t)
  let clockMs = Date.parse(at)
  const first = client('https://first.example/rpc')
  const backup = client('https://backup.example/rpc')
  const selection = selectLocalCarryExitV2NoNeonRoutes(clockMs)
  const choose = async (urls, _route, transport) => transport(urls[0])
  const captureBaseline = async ({ routeKey, destination, asset, provider }) => ({
    routeKey,
    destination,
    asset,
    provider,
    targetBlock: '10',
  })
  const discoverCandidate = async ({ baseline: row }) => {
    if (
      row.destination === selection.morpho.destination &&
      row.provider === new URL(first.url).origin
    )
      clockMs += 121_000
    return candidate()
  }
  first.request = backup.request = async () => '0x1'
  let selectedPrimary = null
  const result = await runLocalCarryExitV2NoNeonIssueTick({
    root,
    now: () => new Date(clockMs),
    minFreeBytes: 0,
    clients: [first, backup],
    verificationUrl: '',
    chooseMorphoOrigin: choose,
    chooseDirectOrigin: choose,
    sourcePreparation: {
      enabled: true,
      morpho: { captureBaseline, discoverCandidate },
      direct: { captureBaseline, discoverCandidate },
      syncVault: { captureBaseline, discoverCandidate, chooseOrigin: choose },
    },
    issueMorpho: async ({ primary }) => {
      selectedPrimary = primary.url
      return { status: 'fixture' }
    },
    issueDirect: async () => ({ status: 'fixture' }),
    issueSyncVault: async () => ({ status: 'fixture' }),
  })
  assert.equal(selectedPrimary, backup.url)
  assert.equal(result.results[0].reason, undefined)
})

test('a swallowed selector failure still reports the exhausted global deadline', async (t) => {
  const root = rootFor(t)
  let clockMs = Date.parse(at)
  const endpoint = client('https://primary.example/rpc')
  endpoint.request = async (method) => {
    if (method === 'eth_chainId') {
      clockMs += 241_000
      return '0x1'
    }
    return { number: '0x10000' }
  }
  const result = await runLocalCarryExitV2NoNeonIssueTick({
    root,
    now: () => new Date(clockMs),
    minFreeBytes: 0,
    clients: [endpoint],
    verificationUrl: '',
    sourcePreparation: { enabled: true },
    issueMorpho: async () => ({ status: 'must_not_issue' }),
    issueDirect: async () => ({ status: 'must_not_issue' }),
    issueSyncVault: async () => ({ status: 'must_not_issue' }),
  })
  assert.equal(result.results[0].reason, 'issuer_deadline_elapsed')
})

test('candidate throttle exhaustion stays typed after every configured provider fails', async (t) => {
  const root = rootFor(t)
  const endpoints = [client('https://one.example/rpc'), client('https://two.example/rpc')]
  for (const endpoint of endpoints) endpoint.request = async () => '0x1'
  const choose = async (urls, _route, transport) => transport(urls[0])
  const captureBaseline = async ({ routeKey, destination, asset, request }) => {
    await request('eth_getBlockByNumber', ['finalized', false])
    return { routeKey, destination, asset, targetBlock: '10' }
  }
  const discoverCandidate = async ({ request }) => {
    await request('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x9' }])
    throw Error('candidate_log_throttle_exhausted')
  }
  const result = await runLocalCarryExitV2NoNeonIssueTick({
    root,
    now,
    minFreeBytes: 0,
    clients: endpoints,
    verificationUrl: '',
    chooseMorphoOrigin: choose,
    chooseDirectOrigin: choose,
    sourcePreparation: {
      enabled: true,
      morpho: { captureBaseline, discoverCandidate },
      direct: { captureBaseline, discoverCandidate },
      syncVault: { captureBaseline, discoverCandidate, chooseOrigin: choose },
    },
    issueMorpho: async () => ({ status: 'must_not_issue' }),
    issueDirect: async () => ({ status: 'must_not_issue' }),
    issueSyncVault: async () => ({ status: 'must_not_issue' }),
  })
  assert.equal(result.results[0].reason, 'candidate_log_throttle_exhausted')
  const attempts = [...verifyLocalCarryExitV2Ledger({ root }).attempts.values()]
  assert.ok(
    attempts.some(
      (row) =>
        row.payload.attemptEnvelope?.issuerAttempt.reason === 'candidate_log_throttle_exhausted',
    ),
  )
})

test('the family RPC-start ceiling includes preparation and prevents a 257th request', async (t) => {
  const root = rootFor(t)
  const endpoint = client('https://primary.example/rpc')
  const counts = { morpho: 0, direct: 0, sync: 0 }
  const routeType = (route) =>
    route.kind === 'morpho' ? 'morpho' : route.kind === 'aave' ? 'direct' : 'sync'
  const choose = async (urls, route, transport) => {
    const family = routeType(route)
    const selected = transport(urls[0])
    if (family === 'morpho') {
      for (let index = 0; index < 257; index++) {
        try {
          await selected.request('eth_chainId', [])
          counts.morpho++
        } catch {
          break
        }
      }
    }
    return selected
  }
  endpoint.request = async () => '0x1'
  const captureBaseline = async ({ routeKey, destination, asset, request }) => {
    await request('eth_chainId', [])
    return { routeKey, destination, asset, targetBlock: '10' }
  }
  const discoverCandidate = async ({ baseline: row, request }) => {
    await request('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x9' }])
    return { ...candidate(), provider: row.provider ?? 'fixture' }
  }
  const result = await runLocalCarryExitV2NoNeonIssueTick({
    sourcePreparation: { enabled: false },
    root,
    now,
    minFreeBytes: 0,
    clients: [endpoint],
    verificationUrl: '',
    chooseMorphoOrigin: choose,
    chooseDirectOrigin: choose,
    sourcePreparation: {
      enabled: true,
      morpho: { captureBaseline, discoverCandidate },
      direct: { captureBaseline, discoverCandidate },
      syncVault: { captureBaseline, discoverCandidate, chooseOrigin: choose },
    },
    issueMorpho: async () => ({ status: 'fixture' }),
    issueDirect: async () => ({ status: 'fixture' }),
    issueSyncVault: async () => ({ status: 'fixture' }),
  })
  assert.equal(counts.morpho, 256)
  assert.equal(result.results[0].reason, 'issuer_rpc_start_limit')
})

test('wrapped preparation errors preserve the shared RPC-start ceiling reason', async (t) => {
  const root = rootFor(t)
  const endpoint = client('https://primary.example/rpc')
  endpoint.request = async () => '0x1'
  const choose = async (urls, _route, transport) => transport(urls[0])
  const captureBaseline = async ({ routeKey, destination, asset, request }) => {
    await request('eth_chainId', [])
    return { routeKey, destination, asset, targetBlock: '10' }
  }
  const discoverCandidate = async ({ request }) => {
    for (let index = 0; index < 256; index++) {
      try {
        await request('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x9' }])
      } catch {
        throw Error('candidate_logs_unavailable')
      }
    }
    return candidate()
  }
  const result = await runLocalCarryExitV2NoNeonIssueTick({
    root,
    now,
    minFreeBytes: 0,
    clients: [endpoint],
    verificationUrl: '',
    chooseMorphoOrigin: choose,
    chooseDirectOrigin: choose,
    sourcePreparation: {
      enabled: true,
      morpho: { captureBaseline, discoverCandidate },
      direct: { captureBaseline, discoverCandidate },
      syncVault: { captureBaseline, discoverCandidate, chooseOrigin: choose },
    },
    issueMorpho: async () => ({ status: 'must_not_issue' }),
    issueDirect: async () => ({ status: 'must_not_issue' }),
    issueSyncVault: async () => ({ status: 'must_not_issue' }),
  })
  assert.equal(result.results[0].reason, 'issuer_rpc_start_limit')
})

test('current sealed episodes recover with zero selector or health-probe RPC, including repeat ticks', async (t) => {
  const root = rootFor(t)
  const selection = selectLocalCarryExitV2NoNeonRoutes(Date.parse(at))
  for (const [family, source] of [
    ['morpho', 'morpho'],
    ['direct', 'direct'],
    ['syncVault', 'sync_vault'],
  ]) {
    const persistence = createLocalCarryExitV2NoNeonPersistence({
      root,
      now,
      source,
      minFreeBytes: 0,
      append(kind, payload, options) {
        if (kind === 'issue') throw Error('crash_after_seal')
        return appendLocalCarryExitV2Record(kind, payload, options)
      },
    })
    await assert.rejects(
      () => persistence.persist(persistence.sql, sealedPlan(selection[family], selection.slot)),
      /crash_after_seal/,
    )
  }
  let probeCalls = 0
  let issuerCalls = 0
  const choose = async () => {
    probeCalls++
    throw Error('health_probe_must_not_run')
  }
  const issuer = async () => {
    issuerCalls++
    throw Error('issuer_must_not_run')
  }
  for (let repeat = 0; repeat < 2; repeat++) {
    const result = await runLocalCarryExitV2NoNeonIssueTick({
      root,
      now,
      minFreeBytes: 0,
      clients: [client('https://primary.example/rpc')],
      verificationUrl: '',
      chooseMorphoOrigin: choose,
      chooseDirectOrigin: choose,
      issueMorpho: issuer,
      issueDirect: issuer,
      issueSyncVault: issuer,
    })
    assert.ok(result.results.every((row) => row.status === 'issued_recovered'))
    assert.equal(result.sealedEpisodeSweep.resumedEpisodes, repeat === 0 ? 3 : 0)
  }
  assert.equal(probeCalls, 0)
  assert.equal(issuerCalls, 0)
  assert.equal(verifyLocalCarryExitV2Ledger({ root }).issues.size, 6)
})

test('68 actual :15/:45 rotations record exactly 10 stable 10,000-unit historical attempts', (t) => {
  const root = rootFor(t)
  const results = []
  for (let rotationIndex = 0; rotationIndex < 68; rotationIndex++) {
    const nativeSlot = rotationIndex * 2
    const slotAtMs = Date.parse(localCarryExitV2NativeSlotAt(nativeSlot))
    results.push(
      recordLocalCarryExitV2HistoricalDenominator({
        root,
        rotationIndex,
        nativeSlot,
        recordedAtMs: slotAtMs + 5 * 60_000,
        minFreeBytes: 0,
      }),
    )
  }
  const unavailable = results.filter((result) => result.status === 'unavailable_attempt_recorded')
  const supported = results.filter((result) => result.status === 'supported_issuer_lane')
  assert.equal(unavailable.length, 10)
  assert.equal(supported.length, 58)
  assert.deepEqual(results[0].counts, {
    routeGroups: 26,
    exactSubjects: 68,
    supportedSubjects: 58,
    unavailableAttemptSubjects: 10,
  })
  assert.ok(
    unavailable.some((result) => result.decimals === 6 && result.assetsRaw === '10000000000'),
  )
  assert.ok(
    unavailable.some(
      (result) => result.decimals === 18 && result.assetsRaw === '10000000000000000000000',
    ),
  )
  const state = verifyLocalCarryExitV2Ledger({ root })
  assert.equal(state.attempts.size, 10)
  assert.equal(state.issues.size, 0)
  assert.ok(
    [...state.attempts.values()].every(
      (row) =>
        row.payload.databaseUsed === false &&
        row.payload.sqlBatchId === null &&
        row.payload.forecastValidated === false,
    ),
  )

  const firstUnavailable = unavailable[0]
  const firstIndex = results.findIndex(
    (result) => result.historicalSubjectId === firstUnavailable.historicalSubjectId,
  )
  const firstSlot = firstIndex * 2
  const firstSlotMs = Date.parse(localCarryExitV2NativeSlotAt(firstSlot))
  assert.equal(
    recordLocalCarryExitV2HistoricalDenominator({
      root,
      rotationIndex: firstIndex,
      nativeSlot: firstSlot,
      recordedAtMs: firstSlotMs + 6 * 60_000,
      minFreeBytes: 0,
    }).attemptId,
    firstUnavailable.attemptId,
  )
  assert.equal(verifyLocalCarryExitV2Ledger({ root }).attempts.size, 10)
})

test('borrowed Morpho, direct USDe and sync-vault orchestrators persist without database access', async (t) => {
  const root = rootFor(t)
  const slot = Math.floor((Date.parse(at) - 10 * 60_000) / (15 * 60_000))
  const morphoRoute = CARRY_EXIT_V2_FROZEN_ROUTES.find((route) => route.kind === 'morpho')
  const directRoute = CARRY_EXIT_V2_FROZEN_ROUTES.find(
    (route) => route.routeKey === 'USDe → supply on Aave V3',
  )
  const syncRoute = CARRY_EXIT_V2_FROZEN_ROUTES.find((route) => route.kind === 'sgho')
  const primary = client('https://primary.example/rpc')
  const secondary = client('https://secondary.example/rpc')

  const morphoPersistence = createLocalCarryExitV2NoNeonPersistence({
    source: 'morpho',
    root,
    now,
    minFreeBytes: 0,
  })
  const morpho = await issueMorphoV2Route({
    ...persistenceOptions(morphoPersistence),
    slot,
    route: morphoRoute,
    primary,
    secondary: null,
    now,
    captureBaseline: async () => baseline(morphoRoute),
    discoverCandidate: async () => candidate(),
    collect: async () => {
      throw Error('proof_should_not_run_without_secondary')
    },
  })

  const directPersistence = createLocalCarryExitV2NoNeonPersistence({
    source: 'direct',
    root,
    now,
    minFreeBytes: 0,
  })
  const direct = await issueDirectV2Route({
    ...persistenceOptions(directPersistence),
    slot,
    route: directRoute,
    primary,
    secondary: null,
    now,
    captureBaseline: async () => baseline(directRoute),
    discoverCandidate: async () => candidate(),
    collect: async () => {
      throw Error('proof_should_not_run_without_secondary')
    },
  })

  const syncPersistence = createLocalCarryExitV2NoNeonPersistence({
    source: 'sync_vault',
    root,
    now,
    minFreeBytes: 0,
  })
  const syncVault = await issueSyncVaultV2Route({
    ...persistenceOptions(syncPersistence),
    slot,
    route: syncRoute,
    primary,
    secondary,
    now,
    captureBaseline: async () => baseline(syncRoute),
    discoverCandidate: async () => candidate(),
    collect: async () => {
      throw Error('fixture_has_no_verified_proof')
    },
  })

  assert.equal(morpho.status, 'issued')
  assert.equal(direct.status, 'issued')
  assert.equal(syncVault.status, 'issued')
  assert.match(morpho.batchId, /^local:morpho:/)
  assert.match(direct.batchId, /^local:direct:/)
  assert.match(syncVault.batchId, /^local:sync_vault:/)
  const state = verifyLocalCarryExitV2Ledger({ root })
  assert.equal(state.issues.size, 18)
  assert.equal(state.attempts.size, 6)
  assert.equal(
    [...state.attempts.values()].filter((row) => row.payload.status === 'sealed').length,
    3,
  )
  assert.equal(
    [...state.issues.values()].filter((row) => row.payload.routeKey === 'USDe → supply on Aave V3')
      .length,
    6,
  )
  assert.ok(
    [...state.issues.values()].every(
      (row) =>
        row.payload.issueEnvelope.authoritativeStore === 'local_carry_exit_v2' &&
        row.payload.issueEnvelope.authority.databaseUsed === false &&
        row.payload.issueEnvelope.authority.sqlBatchId === null,
    ),
  )
})

test('one tick invokes every supported family with local-only persistence callbacks', async (t) => {
  const root = rootFor(t)
  const calls = []
  const issuer = (family) => async (options) => {
    calls.push({ family, route: options.route, sql: options.sql })
    assert.equal(typeof options.sql, 'function')
    assert.equal(typeof options.persist, 'function')
    assert.equal(typeof options.recordDbAttempt, 'function')
    assert.equal(typeof options.recordLocalIssues, 'function')
    return { status: 'unavailable', reason: 'fixture_unavailable' }
  }
  const result = await runLocalCarryExitV2NoNeonIssueTick({
    sourcePreparation: { enabled: false },
    root,
    now,
    minFreeBytes: 0,
    issueMorpho: issuer('morpho'),
    issueDirect: issuer('direct'),
    issueSyncVault: issuer('sync_vault'),
  })
  assert.deepEqual(
    calls.map((entry) => entry.family),
    ['morpho', 'direct', 'sync_vault'],
  )
  assert.deepEqual(result.routeCounts, { morpho: 68, direct: 4, syncVault: 8, umbrellaGho: 0 })
  assert.equal(result.databaseUsed, false)
  assert.equal(result.sqlBatchIdsUsed, false)
  assert.equal(result.databaseTimestampUsed, false)
  assert.equal(result.authoritativeStore, 'local_carry_exit_v2')
  assert.deepEqual(result.registryRouteCounts, {
    morpho: 68,
    direct: 4,
    syncVault: 8,
    umbrellaGho: 0,
  })
  assert.deepEqual(result.historicalDenominatorCounts, {
    routeGroups: 26,
    exactSubjects: 68,
    supportedSubjects: 58,
    unavailableAttemptSubjects: 10,
  })
  assert.equal(
    result.results.every((entry) => entry.databaseUsed === false),
    true,
  )
})

test('a current sealed episode completes before its family issuer can perform RPC work', async (t) => {
  const root = rootFor(t)
  const tickAt = new Date('2026-10-07T12:11:00.000Z')
  const selection = selectLocalCarryExitV2NoNeonRoutes(tickAt.getTime())
  const plan = sealedPlan(selection.direct, selection.slot)
  let failOnce = true
  const persistence = createLocalCarryExitV2NoNeonPersistence({
    source: 'direct',
    root,
    now: () => tickAt,
    minFreeBytes: 0,
    append(kind, payload, options) {
      if (kind === 'issue' && failOnce) {
        failOnce = false
        throw Error('crash_after_seal')
      }
      return appendLocalCarryExitV2Record(kind, payload, options)
    },
  })
  await assert.rejects(() => persistence.persist(persistence.sql, plan), /crash_after_seal/)
  let directCalls = 0
  const result = await runLocalCarryExitV2NoNeonIssueTick({
    sourcePreparation: { enabled: false },
    root,
    now: () => tickAt,
    minFreeBytes: 0,
    issueMorpho: async () => ({ status: 'unavailable', reason: 'fixture' }),
    issueDirect: async () => {
      directCalls++
      throw Error('rpc_must_not_run')
    },
    issueSyncVault: async () => ({ status: 'unavailable', reason: 'fixture' }),
  })
  assert.equal(directCalls, 0)
  assert.equal(result.sealedEpisodeSweep.resumedEpisodes, 1)
  const direct = result.results.find((entry) => entry.family === 'direct')
  assert.equal(direct.status, 'issued_recovered')
  assert.equal(direct.localEpisodeId, localCarryExitV2EpisodeId('direct', plan))
  const state = verifyLocalCarryExitV2Ledger({ root })
  assert.equal(
    [...state.issues.values()].filter(
      (row) => row.payload.issueEnvelope.episodeId === direct.localEpisodeId,
    ).length,
    2,
  )
})

test('a later scheduler tick sweeps seal-only and partial episodes once despite failed RPC', async (t) => {
  for (const persistedBeforeCrash of [0, 1]) {
    await t.test(`existing Q rows ${persistedBeforeCrash}`, async (inner) => {
      const root = rootFor(inner)
      const priorAt = new Date('2026-10-07T12:11:00.000Z')
      const laterAt = new Date('2026-10-07T12:45:00.000Z')
      const prior = selectLocalCarryExitV2NoNeonRoutes(priorAt.getTime())
      const plan = sealedPlan(prior.direct, prior.slot)
      let issueAppends = 0
      let crashed = false
      const persistence = createLocalCarryExitV2NoNeonPersistence({
        source: 'direct',
        root,
        now: () => priorAt,
        minFreeBytes: 0,
        append(kind, payload, options) {
          if (kind === 'issue' && issueAppends === persistedBeforeCrash && !crashed) {
            crashed = true
            throw Error('simulated_tick_crash')
          }
          if (kind === 'issue') issueAppends++
          return appendLocalCarryExitV2Record(kind, payload, options)
        },
      })
      await assert.rejects(() => persistence.persist(persistence.sql, plan), /simulated_tick_crash/)
      assert.equal(verifyLocalCarryExitV2Ledger({ root }).issues.size, persistedBeforeCrash)

      let failedIssuerCalls = 0
      const failingIssuer = async () => {
        failedIssuerCalls++
        throw Error('rpc_failed')
      }
      const first = await runLocalCarryExitV2NoNeonIssueTick({
        sourcePreparation: { enabled: false },
        root,
        now: () => laterAt,
        minFreeBytes: 0,
        issueMorpho: failingIssuer,
        issueDirect: failingIssuer,
        issueSyncVault: failingIssuer,
      })
      assert.equal(failedIssuerCalls, 3)
      assert.equal(first.sealedEpisodeSweep.resumedEpisodes, 1)
      assert.equal(first.sealedEpisodeSweep.appendedIssues, 2 - persistedBeforeCrash)
      const episodeId = localCarryExitV2EpisodeId('direct', plan)
      const afterFirst = verifyLocalCarryExitV2Ledger({ root })
      assert.equal(
        [...afterFirst.issues.values()].filter(
          (row) => row.payload.issueEnvelope.episodeId === episodeId,
        ).length,
        2,
      )

      const second = await runLocalCarryExitV2NoNeonIssueTick({
        sourcePreparation: { enabled: false },
        root,
        now: () => laterAt,
        minFreeBytes: 0,
        issueMorpho: failingIssuer,
        issueDirect: failingIssuer,
        issueSyncVault: failingIssuer,
      })
      assert.equal(second.sealedEpisodeSweep.resumedEpisodes, 0)
      const afterSecond = verifyLocalCarryExitV2Ledger({ root })
      assert.equal(
        [...afterSecond.issues.values()].filter(
          (row) => row.payload.issueEnvelope.episodeId === episodeId,
        ).length,
        2,
      )
    })
  }
})

test('Fluid rotation records a typed unavailable attempt without RPC or issue rows', async (t) => {
  const root = rootFor(t)
  const roster = localCarryExitV2NoNeonRoster()
  const fluidIndex = roster.syncVault.findIndex((route) => route.kind === 'fluid')
  assert.notEqual(fluidIndex, -1)
  const rotationIndex = fluidIndex
  const fluidNow = () => new Date(rotationIndex * 30 * 60_000 + 15 * 60_000)
  const result = await runLocalCarryExitV2NoNeonIssueTick({
    sourcePreparation: { enabled: false },
    root,
    now: fluidNow,
    minFreeBytes: 0,
    issueMorpho: async () => ({ status: 'unavailable', reason: 'fixture' }),
    issueDirect: async () => ({ status: 'unavailable', reason: 'fixture' }),
  })
  const sync = result.results.find((entry) => entry.family === 'sync_vault')
  assert.equal(sync.status, 'unavailable')
  assert.equal(sync.reason, 'fluid_delivery_unproven')
  const state = verifyLocalCarryExitV2Ledger({ root })
  assert.equal(state.issues.size, 0)
  const attempt = [...state.attempts.values()].find(
    (row) => row.payload.stage === 'sync_vault_issue',
  ).payload.attemptEnvelope
  assert.equal(attempt.issuerAttempt.reason, 'fluid_delivery_unproven')
  assert.equal(attempt.databaseUsed, false)
  assert.equal(attempt.sqlBatchId, null)
})
