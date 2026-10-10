// Offline controls only. Mock quote results never establish native/original authority.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { encodeFunctionResult, decodeFunctionData } from 'viem'
import {
  ABI,
  HOSTS,
  CONTRACTS,
  Q_RAW,
  BATCH_SIZES,
  FLAGS,
  PLAN_PATH,
  snapshot,
  containsSecret,
  safeOriginalSnapshot,
  writeCohortArtifact,
  nativeCapacityRaw,
  fluidUsdtNativeConversionExtensionRequests,
  replayFluidUsdtNativeConversionExtensionPoint,
  verifyConversionPhysical,
  cohortDispatchAllowed,
  cohortRetentionAllowed,
  prepareFluidUsdtNativeConversionExtensionPlan,
  main,
} from '../../scripts/research/fluid-usdt-native-conversion-extension.mjs'

const ROOT = resolve(import.meta.dirname, '../..')
const plan = JSON.parse(readFileSync(resolve(ROOT, PLAN_PATH), 'utf8'))
const anchor = plan.anchors[0]
const sha = (v) => createHash('sha256').update(v).digest('hex')
const original = JSON.parse(readFileSync(resolve(ROOT, plan.capturePaths[0]), 'utf8'))
const conversion = JSON.parse(
  readFileSync(
    resolve(
      ROOT,
      'data/research/venue-signals/fluid-usdt-historical-conversion-2026-10-07T14-14.json',
    ),
    'utf8',
  ),
)
const runtimeCodes = Object.fromEntries(
  ['factory', 'quoter', 'pool'].map((k) => [
    k,
    conversion.traces.find((t) => t.key === 'code_' + k).response.result,
  ]),
)
const usdcRow = original.ledger.find(
  (r) => r.request.method === 'eth_getCode' && r.request.params[0] === CONTRACTS.usdc,
)
runtimeCodes.usdc = JSON.parse(Buffer.from(usdcRow.rawBodyBase64, 'base64').toString('utf8')).result
runtimeCodes.usdt = '0x6001600055' // Deliberately unsigned synthetic unknown-token runtime.
const header = (a) => ({
  number: '0x' + BigInt(a.source.blockNumber).toString(16),
  hash: a.source.blockHash,
  timestamp: '0x' + BigInt(Date.parse(a.source.blockTime) / 1000).toString(16),
})
function resultFor(spec, a) {
  if (spec.key.startsWith('header_')) return header(a)
  if (spec.key.startsWith('code_')) return runtimeCodes[spec.key.slice(5)]
  const values = {
    factory_pool: CONTRACTS.pool,
    token0: CONTRACTS.usdc,
    token1: CONTRACTS.usdt,
    pool_factory: CONTRACTS.factory,
    pool_fee: 100,
    usdc_decimals: 6,
    usdt_decimals: 6,
    pool_liquidity: 1000000n,
  }
  const result = Object.hasOwn(values, spec.key)
    ? values[spec.key]
    : [
        spec.key === 'required_usdc_for_research_q'
          ? 10144n
          : BigInt(spec.key === 'full_ea_usdt' ? a.fullNetEaRaw : a.clippedNetCapacityRaw) + 1n,
        100n,
        0,
        50000n,
      ]
  return encodeFunctionResult({ abi: ABI, functionName: spec.name, result })
}
function fixture(a = anchor) {
  const specs = fluidUsdtNativeConversionExtensionRequests(a)
  return HOSTS.map((host, h) => ({
    host,
    traces: specs.map((spec, n) => ({
      key: spec.key,
      request: structuredClone(spec.request),
      envelope: { jsonrpc: '2.0', id: n + 1, result: resultFor(spec, a) },
      startedAtUtc: new Date(
        Date.parse('2026-10-09T04:00:00.000Z') + n * 250 + h * 10,
      ).toISOString(),
      completedAtUtc: new Date(
        Date.parse('2026-10-09T04:00:00.000Z') + n * 250 + h * 10 + 1,
      ).toISOString(),
      requestBodySha256: 'a'.repeat(64),
      responseBodySha256: 'b'.repeat(64),
    })),
  }))
}
const replay = (a = anchor, w = fixture(a)) =>
  replayFluidUsdtNativeConversionExtensionPoint(a, w, plan.conversionRuntimePins)
function errorQuote(w, key) {
  for (const o of w) {
    const t = o.traces.find((x) => x.key === key)
    t.envelope = {
      jsonrpc: '2.0',
      id: t.envelope.id,
      error: { code: 3, message: 'native_error', data: '0x12345678' },
    }
  }
}
function physicalFixture() {
  const anchors = plan.anchors.slice(0, 3),
    ledger = [],
    requests = []
  const add = (host, stage, key, spec, result) => {
    const id = ledger.length + 1,
      request = { jsonrpc: '2.0', id, ...structuredClone(spec) }
    const requestBytes = Buffer.from(JSON.stringify(request)),
      bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }))
    const at = Math.floor((id - 1) / 2) * 250
    const row = {
      physicalId: id,
      host,
      stage,
      request,
      startedElapsedMs: at,
      completedElapsedMs: at + 1,
      accepted: true,
      status: 'success',
      httpStatus: 200,
      bodyBytes: bytes.length,
      bodySha256: sha(bytes),
      rawBodyBase64: bytes.toString('base64'),
    }
    ledger.push(row)
    requests.push({
      id,
      host,
      stage,
      key,
      requestBodyBase64: requestBytes.toString('base64'),
      requestBodySha256: sha(requestBytes),
    })
  }
  HOSTS.forEach((host) => add(host, 'chain', 'chain', { method: 'eth_chainId', params: [] }, '0x1'))
  for (const a of anchors)
    for (const spec of fluidUsdtNativeConversionExtensionRequests(a))
      HOSTS.forEach((host) =>
        add(host, 'anchor_' + a.source.blockNumber, spec.key, spec.request, resultFor(spec, a)),
      )
  const settlements = ledger.map((row) => {
    const body = {
      schema: 'usd3_hypothetical_physical_settlement_v1',
      physicalId: row.physicalId,
      captureAcceptance: false,
      observation: row,
    }
    return { ...body, sha256: sha(JSON.stringify(body)) }
  })
  const receipt = {
    physicalStarts: 110,
    pendingSettlements: 0,
    failure: null,
    ledger,
    terminalCommitments: ledger.map((r) => ({
      physicalId: r.physicalId,
      rowSha256: sha(JSON.stringify(r)),
    })),
  }
  return { receipt, settlements, requests, anchors }
}
const verify = (f) => verifyConversionPhysical(f.receipt, f.settlements, f.requests, 110, f.anchors)
function mockIo(overrides = {}) {
  const file = {
    dev: 1,
    ino: 1,
    size: 0,
    nlink: 1,
    mode: 0o600,
    mtimeMs: 0,
    ctimeMs: 0,
    isFile: () => true,
    isSymbolicLink: () => false,
  }
  return {
    reserve: () => {},
    open: () => 1,
    stat: () => ({ ...file }),
    namedStat: () => ({ ...file }),
    write: (_, b) => {
      file.size = b.length
    },
    flush: () => {},
    close: () => {},
    sync: () => {},
    ...overrides,
  }
}
const state = () => ({ accounted: 0, files: [], incomplete: [] })

test('sealed originals independently rejoin all ten states at unchanged full S', () => {
  const replayStartedAt = Date.now(),
    p = prepareFluidUsdtNativeConversionExtensionPlan(),
    replayCompletedAt = Date.now()
  assert.equal(p.anchors.length, 10)
  assert.equal(p.physicalStarts, 368)
  assert.deepEqual(p.batchSizes, [3, 3, 2, 2])
  assert.equal(p.actualUserQuestion, false)
  assert.ok(p.anchors.every((a) => a.fullSharesRaw === '967573479322309282' && a.owner === null))
  assert.equal(p.anchors[8].source.blockNumber, '26101887')
  assert.equal(p.anchors[9].source.blockNumber, '26102143')
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.anchors[0].source))
  assert.deepEqual(p.nativeOriginalReplay.capturePaths, [
    plan.capturePaths[1],
    plan.capturePaths[0],
  ])
  assert.ok(Date.parse(p.nativeOriginalReplay.reconstructedAtUtc) >= replayStartedAt)
  assert.ok(Date.parse(p.nativeOriginalReplay.completedAtUtc) <= replayCompletedAt)
  assert.ok(
    Date.parse(p.nativeOriginalReplay.completedAtUtc) >=
      Date.parse(p.nativeOriginalReplay.reconstructedAtUtc),
  )
  assert.equal(p.reconstructedAtUtc, plan.reconstructedAtUtc) // Original report clock remains historical metadata.
  assert.deepEqual(p.anchors, plan.anchors) // Native source/acquisition/availability clocks are unchanged.
})
test('exact plan is18 calls and fixed research Q never supplies full Ea', () => {
  const specs = fluidUsdtNativeConversionExtensionRequests(anchor)
  assert.equal(specs.length, 18)
  assert.equal(
    BATCH_SIZES.reduce((s, n) => s + 2 + n * 36, 0),
    368,
  )
  const amounts = Object.fromEntries(
    specs
      .filter((s) => s.key.includes('usdt') || s.key === 'required_usdc_for_research_q')
      .filter((s) => s.name?.startsWith('quote'))
      .map((s) => [
        s.key,
        decodeFunctionData({ abi: ABI, data: s.request.params[0].data }).args[0],
      ]),
  )
  assert.equal(amounts.full_ea_usdt.amountIn, BigInt(anchor.fullNetEaRaw))
  assert.equal(amounts.clipped_capacity_usdt.amountIn, BigInt(anchor.clippedNetCapacityRaw))
  assert.equal(amounts.required_usdc_for_research_q.amount, BigInt(Q_RAW))
  assert.notEqual(anchor.fullNetEaRaw, Q_RAW)
  for (const spec of specs.filter((s) => !s.key.startsWith('header_')))
    assert.deepEqual(spec.request.params[1], {
      blockHash: anchor.source.blockHash,
      requireCanonical: true,
    })
})
test('paired native-shaped fixture preserves units, full S and false authority', () => {
  const p = replay()
  assert.equal(p.outputAsset, CONTRACTS.usdt)
  assert.equal(p.outputDecimals, 6)
  assert.equal(p.shareDecimals, 18)
  assert.equal(p.fullSharesRaw, anchor.fullSharesRaw)
  assert.equal(p.requiredNetUsdcForResearchQRaw, '10144')
  assert.equal(p.MRaw, null)
  assert.equal(p.actualUserQuestion, false)
  for (const [k, v] of Object.entries(FLAGS)) assert.equal(p[k], v)
  assert.equal(p.acquiredAtUtc, '2026-10-09T04:00:04.261Z')
  assert.equal(p.oldBridgeAcquiredAtUtc, anchor.oldAcquiredAtUtc)
})
test('weak funding prong is clipped before conversion, with native fee exactly once', () => {
  const a = structuredClone(anchor)
  a.nativeProngs.bankCash = '1000'
  a.clippedNetCapacityRaw = nativeCapacityRaw(a.fullNetEaRaw, a.nativeProngs, 5)
  assert.equal(a.clippedNetCapacityRaw, '999')
  const specs = fluidUsdtNativeConversionExtensionRequests(a)
  const q = decodeFunctionData({
    abi: ABI,
    data: specs.find((s) => s.key === 'clipped_capacity_usdt').request.params[0].data,
  })
  assert.equal(q.args[0].amountIn, 999n)
  assert.equal(replay(a).clippedNetUsdcCapacityRaw, '999')
})
test('unsupported native quote is censored and never fabricated zero', () => {
  const w = fixture()
  errorQuote(w, 'full_ea_usdt')
  const p = replay(anchor, w)
  assert.equal(p.fullEaQuotedUsdtRaw, null)
  assert.equal(p.status, 'censored_native_quote_error')
  assert.equal(p.clippedCapacityQuotedUsdtRaw, BigInt(anchor.clippedNetCapacityRaw) + 1n + '')
})
test('one-origin quote error or unequal native outputs fails closed', () => {
  const w = fixture()
  errorQuote(w, 'full_ea_usdt')
  w[1].traces[14] = fixture()[1].traces[14]
  assert.throws(() => replay(anchor, w))
  const drift = fixture()
  drift[1].traces[14].envelope.result = encodeFunctionResult({
    abi: ABI,
    functionName: 'quoteExactInputSingle',
    result: [999n, 100n, 0, 50000n],
  })
  assert.throws(() => replay(anchor, drift))
})
test('pool identity, fee, decimals and canonical ABI words are mandatory', () => {
  for (const key of ['token0', 'pool_fee', 'usdt_decimals']) {
    const w = fixture()
    const t = w[0].traces.find((t) => t.key === key)
    t.envelope.result = encodeFunctionResult({
      abi: ABI,
      functionName: key === 'token0' ? 'token0' : key === 'pool_fee' ? 'fee' : 'decimals',
      result: key === 'token0' ? CONTRACTS.usdt : 7,
    })
    assert.throws(() => replay(anchor, w))
  }
  const w = fixture()
  w[0].traces[14].envelope.result += '00'
  assert.throws(() => replay(anchor, w))
})
test('wrong header, exact-input amount, canonical flag and source are rejected', () => {
  for (const mutate of [
    (w) => {
      w[0].traces[0].envelope.result.hash = '0x' + 'f'.repeat(64)
    },
    (w) => {
      w[0].traces[14].request.params[0].data = '0x'
    },
    (w) => {
      w[0].traces[14].request.params[1].requireCanonical = false
    },
    (w) => {
      w[0].traces[17].envelope.result.timestamp = '0x1'
    },
  ]) {
    const w = fixture()
    mutate(w)
    assert.throws(() => replay(anchor, w))
  }
})
test('runtime byte identity and pinned known code survive cross-origin checks', () => {
  const w = fixture()
  w[1].traces[5].envelope.result = '0x6002600055'
  assert.throws(() => replay(anchor, w))
  const bad = fixture()
  bad[0].traces[1].envelope.result = '0x00'
  assert.throws(() => replay(anchor, bad))
  const empty = fixture()
  empty[0].traces[5].envelope.result = '0x'
  assert.throws(() => replay(anchor, empty))
})
test('wrong S, weak-prong amount, units policy and fee fail before quote construction', () => {
  for (const mutate of [
    (a) => {
      a.fullSharesRaw = '10145'
    },
    (a) => {
      a.clippedNetCapacityRaw = '1'
    },
    (a) => {
      a.feeBps = 0
    },
    (a) => {
      a.owner = '0x' + '1'.repeat(40)
    },
    (a) => {
      a.source.chainId = 2
    },
  ]) {
    const a = structuredClone(anchor)
    mutate(a)
    assert.throws(() => fluidUsdtNativeConversionExtensionRequests(a))
  }
  assert.throws(() => nativeCapacityRaw('1', { ...anchor.nativeProngs, extra: '1' }, 5))
})
test('read clock reversal and missing commitment metadata fail closed', () => {
  const w = fixture()
  w[0].traces[1].startedAtUtc = w[0].traces[0].startedAtUtc
  assert.throws(() => replay(anchor, w))
  const missing = fixture()
  delete missing[1].traces[3].responseBodySha256
  assert.throws(() => replay(anchor, missing))
})
test('new quote acquisition cannot predate the retained input availability', () => {
  const w = fixture()
  const early = '2026-10-07T00:00:00.000Z'
  w[0].traces[0].startedAtUtc = early
  w[0].traces[0].completedAtUtc = early
  assert.throws(() => replay(anchor, w))
})
test('snapshot rejects accessors, cycles, sparse arrays and oversized keys without invoking getter', () => {
  let touched = false
  const a = {}
  Object.defineProperty(a, 'value', {
    enumerable: true,
    get() {
      touched = true
      return 1
    },
  })
  assert.throws(() => snapshot(a))
  assert.equal(touched, false)
  const cycle = {}
  cycle.self = cycle
  assert.throws(() => snapshot(cycle))
  assert.throws(() => snapshot([, 1]))
  assert.throws(() => snapshot({ ['x'.repeat(257)]: 1 }))
  const shared = { a: 1 }
  assert.deepEqual(snapshot({ one: shared, two: shared }), { one: { a: 1 }, two: { a: 1 } })
})
test('safe snapshot isolates subsequent caller mutations', () => {
  const w = fixture(),
    copy = snapshot(w)
  w[0].traces[0].envelope.result.hash = '0x' + 'f'.repeat(64)
  assert.equal(replay(anchor, copy).status, 'conditional_native_quotes')
})
test('literal, JSON escaped key/value and percent credential echoes are rejected', () => {
  const token = 'verySecretConfiguredKey'
  for (const body of [
    '{"error":"' + token + '"}',
    '{"' + token + '":"x"}',
    '{"error":"verySecretConfigured\\u004bey"}',
    '{"error":"verySecretConfigured%4Bey"}',
  ])
    assert.equal(containsSecret(Buffer.from(body), [token]), true)
  assert.equal(containsSecret(Buffer.from('{"result":"0x01"}'), [token]), false)
})
test('malformed escaped body fails privacy-unknown before retention', () => {
  assert.equal(containsSecret(Buffer.from('{"error":"hidden\\u004bey'), ['unrelated']), true)
})
test('late escaped secret absent from frozen ledger blocks entire original retention', () => {
  const bytes = Buffer.from('{"error":"verySecretConfigured\\u004bey"}')
  const late = {
    physicalId: 1,
    observation: {
      rawBodyBase64: bytes.toString('base64'),
      bodyBytes: bytes.length,
      bodySha256: sha(bytes),
    },
  }
  assert.throws(() => safeOriginalSnapshot({ ledger: [] }, [late], ['verySecretConfiguredKey']))
  const safe = Buffer.from('{"result":"0x1"}')
  late.observation = {
    rawBodyBase64: safe.toString('base64'),
    bodyBytes: safe.length,
    bodySha256: sha(safe),
  }
  assert.equal(safeOriginalSnapshot({ ledger: [] }, [late], ['secret']).settlements.length, 1)
})
test('noncanonical base64 and mutated original digest are rejected', () => {
  const bytes = Buffer.from('{"result":"0x1"}'),
    row = {
      rawBodyBase64: bytes.toString('base64') + '=',
      bodyBytes: bytes.length,
      bodySha256: sha(bytes),
    }
  assert.throws(() => safeOriginalSnapshot({ ledger: [row] }, [], []))
  row.rawBodyBase64 = bytes.toString('base64')
  row.bodySha256 = '0'.repeat(64)
  assert.throws(() => safeOriginalSnapshot({ ledger: [row] }, [], []))
})
test('writer reserves terminal tail and cannot spend it on regular payloads', () => {
  const s = state()
  s.accounted = 32 * 1024 * 1024 - 512 * 1024
  assert.throws(() => writeCohortArtifact(s, 'extra.bin', Buffer.from('x'), mockIo()))
  writeCohortArtifact(s, 'terminal.json', Buffer.from('{}'), mockIo(), true)
  assert.equal(s.files.length, 1)
  assert.throws(() =>
    writeCohortArtifact(
      state(),
      'too-big-terminal.json',
      Buffer.alloc(512 * 1024 + 1),
      mockIo(),
      true,
    ),
  )
})
test('fully attempted fsync-failed file remains charged and incomplete', () => {
  const s = state()
  assert.throws(() =>
    writeCohortArtifact(
      s,
      'attempt.bin',
      Buffer.alloc(100),
      mockIo({
        flush() {
          throw Error('controlled fsync failure')
        },
      }),
    ),
  )
  assert.equal(s.accounted, 100)
  assert.deepEqual(s.incomplete, [{ file: 'attempt.bin', reservedBytes: 100 }])
  assert.equal(s.files.length, 0)
})
test('reserve gate happens before open; unsafe mode is rejected after conservative charge', () => {
  let opened = false
  assert.throws(() =>
    writeCohortArtifact(
      state(),
      'file.bin',
      Buffer.alloc(10),
      mockIo({
        reserve() {
          throw Error('reserve')
        },
        open() {
          opened = true
          return 1
        },
      }),
    ),
  )
  assert.equal(opened, false)
  const s = state()
  assert.throws(() =>
    writeCohortArtifact(
      s,
      'file.bin',
      Buffer.alloc(10),
      mockIo({ stat: () => ({ isFile: () => true, nlink: 2, mode: 0o644 }) }),
    ),
  )
  assert.equal(s.accounted, 10)
})
test('post-fsync replaced named inode stays charged and unpublished', () => {
  const s = state()
  let closed = false
  assert.throws(
    () =>
      writeCohortArtifact(
        s,
        'drift.bin',
        Buffer.alloc(100),
        mockIo({
          namedStat: () => ({
            dev: 1,
            ino: 2,
            size: 100,
            nlink: 1,
            mode: 0o600,
            mtimeMs: 0,
            ctimeMs: 0,
            isFile: () => true,
            isSymbolicLink: () => false,
          }),
          close() {
            closed = true
          },
        }),
      ),
    /artifact_identity/,
  )
  assert.equal(closed, true)
  assert.equal(s.accounted, 100)
  assert.equal(s.files.length, 0)
  assert.equal(s.incomplete.length, 1)
})
test('post-fsync hardlink, unsafe mode and symlink stay unpublished', () => {
  for (const drift of [{ nlink: 2 }, { mode: 0o644 }, { isSymbolicLink: () => true }]) {
    const s = state(),
      base = mockIo(),
      named = base.namedStat
    assert.throws(
      () =>
        writeCohortArtifact(s, 'unsafe.bin', Buffer.alloc(10), {
          ...base,
          namedStat: () => ({ ...named(), ...drift }),
        }),
      /artifact_identity/,
    )
    assert.equal(s.accounted, 10)
    assert.equal(s.files.length, 0)
    assert.equal(s.incomplete.length, 1)
  }
})
test('post-fsync descriptor short size cannot publish intended byte hash', () => {
  const s = state(),
    base = mockIo(),
    fdStat = base.stat
  let calls = 0
  assert.throws(
    () =>
      writeCohortArtifact(s, 'short.bin', Buffer.alloc(10), {
        ...base,
        stat: () => {
          calls++
          return { ...fdStat(), ...(calls > 1 ? { size: 9 } : {}) }
        },
      }),
    /artifact_identity/,
  )
  assert.equal(s.accounted, 10)
  assert.equal(s.files.length, 0)
  assert.equal(s.incomplete.length, 1)
})
test('successful post-fsync named and descriptor identity permits publication', () => {
  const s = state(),
    bytes = Buffer.from('exact-original')
  writeCohortArtifact(s, 'safe.bin', bytes, mockIo())
  assert.deepEqual(s.files, [{ file: 'safe.bin', bytes: bytes.length, sha256: sha(bytes) }])
  assert.deepEqual(s.incomplete, [])
})
test('synchronous pin validation crossing cohort deadline is rejected at end', () => {
  assert.equal(cohortRetentionAllowed(479999, 368), true)
  assert.throws(() => cohortRetentionAllowed(480000, 368), /cohort_deadline_or_count/)
  const source = readFileSync(
    resolve(ROOT, 'scripts/research/fluid-usdt-native-conversion-extension.mjs'),
    'utf8',
  )
  assert.match(
    source,
    /plan\.inputs\.forEach\(readPin\);?\s*plan\.sourcePins\.forEach\(readPin\);?\s*cohortRetentionAllowed\(\s*performance\.now\(\)\s*-\s*started\s*,\s*actualStarts\s*,\s*cohortExpired\s*,?\s*\)/,
  )
})
test('post-terminal-fsync clock cannot return complete after deadline or expiry', () => {
  for (const [elapsed, expired] of [
    [480000, false],
    [479999, true],
    [NaN, false],
    [-1, false],
  ])
    assert.throws(() => cohortRetentionAllowed(elapsed, 368, expired))
  const source = readFileSync(
    resolve(ROOT, 'scripts/research/fluid-usdt-native-conversion-extension.mjs'),
    'utf8',
  )
  assert.match(
    source,
    /save\(\s*['"]terminal\.json['"]\s*,\s*\{\s*\.\.\.terminal\s*,\s*sha256:\s*sha\(\s*canonical\(terminal\)\s*\)\s*,?\s*\}\s*,\s*true\s*,?\s*\);?\s*const\s+elapsedMs\s*=\s*performance\.now\(\)\s*-\s*started/,
  )
  assert.match(
    source,
    /cohortRetentionAllowed\(\s*elapsedMs\s*,\s*actualStarts\s*,\s*cohortExpired\s*,?\s*\)/,
  )
  assert.match(source, /completionScope:\s*['"]native_data_qualified_before_terminal_retention['"]/)
  assert.match(source, /retentionCompletedAtUtc:\s*null/)
})
test('hard cohort deadline and count stop dispatch at the exact boundaries', () => {
  assert.equal(cohortDispatchAllowed(479999, 367), true)
  for (const [ms, n] of [
    [480000, 0],
    [0, 368],
    [-1, 0],
    [NaN, 0],
    [0, -1],
  ])
    assert.throws(() => cohortDispatchAllowed(ms, n))
})
test('all raw physical starts, request bytes, settlements and terminal commitments join', () => {
  assert.equal(verify(physicalFixture()), true)
})
test('duplicate physical ID, commitment drift and raw-envelope mutation fail closed', () => {
  for (const mutate of [
    (f) => {
      f.receipt.ledger[1].physicalId = 1
    },
    (f) => {
      f.receipt.terminalCommitments[0].rowSha256 = '0'.repeat(64)
    },
    (f) => {
      f.requests[0].requestBodySha256 = '0'.repeat(64)
    },
    (f) => {
      f.settlements[0].observation.bodyBytes++
    },
    (f) => {
      f.receipt.pendingSettlements = 1
    },
  ]) {
    const f = physicalFixture()
    mutate(f)
    assert.throws(() => verify(f))
  }
})
test('physical ledger cannot substitute arbitrary calls for the fixed anchor plan', () => {
  const f = physicalFixture()
  const r = f.receipt.ledger[2]
  r.request.params[0] = '0x1'
  const bytes = Buffer.from(JSON.stringify(r.request)),
    q = f.requests.find((q) => q.id === r.request.id)
  q.requestBodyBase64 = bytes.toString('base64')
  q.requestBodySha256 = sha(bytes)
  f.receipt.terminalCommitments[2].rowSha256 = sha(JSON.stringify(r))
  const s = f.settlements[2],
    { sha256, ...body } = s
  s.sha256 = sha(JSON.stringify(body))
  assert.throws(() => verify(f))
})
test('fee intermediate overflow and zero capacity stay explicit', () => {
  const max = ((1n << 256n) - 1n).toString(),
    huge = Object.fromEntries(Object.keys(anchor.nativeProngs).map((k) => [k, max]))
  assert.throws(() => nativeCapacityRaw('1', huge, 5))
  assert.equal(
    nativeCapacityRaw(anchor.fullNetEaRaw, { ...anchor.nativeProngs, bankCash: '0' }, 5),
    '0',
  )
})
test('import/default main never acquires without the exact manual flag', () => {
  for (const args of [[], ['--current'], ['--capture', 'extra']]) assert.throws(() => main(args))
})
