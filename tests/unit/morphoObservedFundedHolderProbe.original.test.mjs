import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, lstatSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import { MORPHO_NATIVE_HEADER_RESPONSE_POLICY } from '../../scripts/research/morpho-probe-raw-body-storage.mjs'
import {
  PLAN_PATH,
  PLAN_SHA,
  prepareMorphoObservedFundedHolderProbe,
  validatePinnedMorphoReceiverLead,
  decodeProbeHeader,
  sameProbeSource,
  probeNativeCall,
  pairedProbeResult,
  decodeProbeWord,
  derivePairedFundedProbe,
  pairProbeLogShard,
  probeReceiverCandidates,
  assertFundedHolderProbePrivacy,
  verifyProbeControl,
  captureMorphoObservedFundedHolderProbe,
} from '../../scripts/research/morpho-observed-funded-holder-probe.mjs'
const sha = (value) => createHash('sha256').update(value).digest('hex')
const clone = (value) => JSON.parse(JSON.stringify(value))
const plan = JSON.parse(readFileSync(PLAN_PATH, 'utf8'))
const hosts = plan.origins
const source = {
  chainId: 1,
  blockNumber: '10240',
  blockHash: '0x' + '11'.repeat(32),
  blockTime: '2026-10-09T08:00:00.000Z',
  finalized: true,
}
const word = (value) => '0x' + BigInt(value).toString(16).padStart(64, '0')
const h = (value) => '0x' + BigInt(value).toString(16).padStart(64, '0')
const addressWord = (value) => '0x' + '0'.repeat(24) + value.slice(2)
function fundedRows(subject, owner, S, Ea) {
  const rows = hosts.map((host) => ({
    host,
    key: subject.id + ':S:' + owner,
    request: probeNativeCall(
      subject.id + ':S:' + owner,
      subject.vault,
      'balanceOf',
      [owner],
      source,
    ),
    envelope: { result: word(S) },
  }))
  if (BigInt(S) > 0n)
    rows.push(
      ...hosts.map((host) => ({
        host,
        key: subject.id + ':Ea:' + owner,
        request: probeNativeCall(
          subject.id + ':Ea:' + owner,
          subject.vault,
          'previewRedeem',
          [BigInt(S)],
          source,
        ),
        envelope: { result: word(Ea) },
      })),
    )
  return rows
}
function log({
  block = 10240,
  owner = '0x' + 'ab'.repeat(20),
  topic = plan.transferTopic,
  index = 1,
  positive = true,
} = {}) {
  return {
    address: plan.subjects[2].vault,
    blockNumber: '0x' + block.toString(16),
    blockHash: h(block),
    transactionHash: h(block * 100 + index),
    transactionIndex: '0x0',
    logIndex: '0x' + index.toString(16),
    topics: [topic, addressWord('0x' + 'cd'.repeat(20)), addressWord(owner)],
    data:
      topic === plan.depositTopic
        ? word(100) + word(positive ? 1000 : 0).slice(2)
        : word(positive ? 1000 : 0),
    removed: false,
  }
}
const ausd = {
  ...plan.subjects[2],
  depositTopic: plan.depositTopic,
  liquidityAdapter: '0x' + 'dd'.repeat(20),
}
const ausdExclusions = [ausd.vault, ausd.liquidityAdapter]
function oneControl() {
  const request = { jsonrpc: '2.0', id: 91, method: 'eth_chainId', params: [] },
    response = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 91, result: '0x1' })),
    requestBytes = Buffer.from(JSON.stringify(request)),
    row = {
      physicalId: 1,
      host: hosts[0],
      stage: 'fixture',
      request,
      startedAtUtc: '2026-10-09T08:20:00.000Z',
      startedElapsedMs: 0,
      completedAtUtc: '2026-10-09T08:20:00.001Z',
      completedElapsedMs: 1,
      status: 'success',
      httpStatus: 200,
      bodyBytes: response.length,
      bodySha256: sha(response),
      rawBodyBase64: response.toString('base64'),
      safeCode: null,
      accepted: true,
    },
    observation = {
      schema: 'usd3_hypothetical_physical_settlement_v1',
      physicalId: 1,
      captureAcceptance: false,
      observation: row,
    }
  return {
    receipt: {
      startedAtUtc: '2026-10-09T08:20:00.000Z',
      availableAtUtc: '2026-10-09T08:20:00.001Z',
      elapsedMs: 1,
      pendingSettlements: 0,
      failure: null,
      physicalStarts: 1,
      ledger: [row],
      terminalCommitments: [{ physicalId: 1, rowSha256: sha(JSON.stringify(row)) }],
    },
    requests: [
      {
        physicalId: 1,
        controlNamespace: 'control-A',
        requestBodyBase64: requestBytes.toString('base64'),
        requestBodySha256: sha(requestBytes),
      },
    ],
    settlements: [{ ...observation, sha256: sha(JSON.stringify(observation)) }],
  }
}
function mockedWriter({ failFsync = false } = {}) {
  const sourceText = readFileSync(
      'scripts/research/morpho-observed-funded-holder-probe.mjs',
      'utf8',
    ),
    start = sourceText.indexOf('export function createProbeWriter('),
    end = sourceText.indexOf('export function verifyProbeControl(', start),
    exact = sourceText.slice(start, end).replace('export function', 'function')
  assert.ok(start >= 0 && end > start)
  const files = new Map(),
    fds = new Map(),
    state = { next: 1, failFsync, opens: 0 },
    out = '/repo/data/research/venue-signals/morpho-observed-funded-holder-probe-fixture'
  const stats = (file) => ({
    isFile: () => Boolean(file),
    isDirectory: () => !file,
    isSymbolicLink: () => false,
    dev: 1,
    ino: file?.ino ?? 0,
    size: file?.bytes.length ?? 0,
    nlink: 1,
    mode: file ? 0o600 : 0o700,
  })
  const context = {
    ROOT: '/repo',
    POLICY: { deadline: 120000, file: 8 * 1024 * 1024, cohort: 32 * 1024 * 1024, terminal: 65536 },
    performance: { now: () => 0 },
    Buffer,
    dirname: (path) => path.slice(0, path.lastIndexOf('/')),
    basename: (path) => path.slice(path.lastIndexOf('/') + 1),
    resolve: (a, b) => (b ? a + '/' + b : a),
    constants: { O_RDONLY: 1, O_DIRECTORY: 2, O_NOFOLLOW: 4, O_WRONLY: 8, O_CREAT: 16, O_EXCL: 32 },
    guard: () => {},
    check: (ok, why) => assert.ok(ok, why),
    assertFundedHolderProbePrivacy: () => true,
    mkdirSync: () => {},
    lstatSync: (path) => stats(files.get(path)),
    openSync: (path, flags) => {
      const fd = state.next++
      state.opens++
      if (flags & 16) {
        assert.ok(!files.has(path))
        files.set(path, { bytes: Buffer.alloc(0), ino: fd })
      }
      fds.set(fd, path)
      return fd
    },
    writeSync: (fd, b, offset, length) => {
      const f = files.get(fds.get(fd))
      f.bytes = Buffer.concat([f.bytes, b.subarray(offset, offset + length)])
      return length
    },
    closeSync: (fd) => fds.delete(fd),
    fstatSync: (fd) => stats(files.get(fds.get(fd))),
    fsyncSync: (fd) => {
      if (state.failFsync && files.has(fds.get(fd))) throw Error('mock_fsync_fail')
    },
    readBytes: (path) => files.get(path).bytes,
    sha,
  }
  const create = vm.runInNewContext(exact + ';createProbeWriter', context)
  return { writer: create(out, [], { clock: () => 0, started: 0 }), state, files }
}

test('immutable plan closes 106 reads, separate32 log reads and unchanged native controls', () => {
  assert.equal(sha(readFileSync(PLAN_PATH)), PLAN_SHA)
  assert.equal(plan.budget.maximumPhysicalStarts, 106)
  assert.equal(plan.budget.maximumDefaultControllerStarts, 74)
  assert.equal(plan.budget.maximumSeparateLogStarts, 32)
  assert.deepEqual(
    [
      plan.policy.stageWindowMs,
      plan.policy.rpcTimeoutMs,
      plan.policy.perHostSpacingMs,
      plan.policy.retries,
    ],
    [12000, 8000, 250, 0],
  )
  assert.equal(plan.policy.globalDeadlineMs, 120000)
  assert.equal(plan.discovery.windowBlocks, 64)
  assert.equal(plan.discovery.shardBlocks, 8)
})
test('real pinned preparation admits canonical package-store files without symlink exceptions', () => {
  const prepared = prepareMorphoObservedFundedHolderProbe()
  const packagePins = prepared.sources.filter((x) => x.pin.path.startsWith('node_modules/.pnpm/'))
  assert.equal(packagePins.length, 3)
  for (const { pin, bytes } of packagePins) {
    assert.equal(realpathSync(pin.path), resolve(pin.path))
    let at = process.cwd()
    for (const part of pin.path.split('/').slice(0, -1)) {
      at = resolve(at, part)
      assert.equal(lstatSync(at).isSymbolicLink(), false)
    }
    assert.equal(sha(bytes), pin.fileSha256)
    assert.equal(bytes.length, pin.bytes)
  }
})
test('actual pinned old public leads decode onBehalf but confer no current balance', () => {
  const prepared = prepareMorphoObservedFundedHolderProbe()
  for (const subject of prepared.plan.subjects)
    for (const c of subject.candidates) {
      const x = prepared.originals.find((x) =>
        x.pin.path.endsWith(String(c.leadOrdinal).padStart(12, '0') + '.json'),
      )
      const lead = validatePinnedMorphoReceiverLead(
        x.bytes,
        x.pin,
        subject,
        c.owner,
        plan.depositTopic,
      )
      assert.equal(lead.currentBalanceKnown, false)
      assert.equal(lead.historicalOwnership, false)
      assert.ok(
        lead.occurrences.every(
          (o) => o.receiver === c.owner && o.occurredAtUtc.startsWith('2026-09-02'),
        ),
      )
    }
})
test('resealed modified old lead is rejected by its exact original FILE pin', () => {
  const pin = plan.leadOriginals[0],
    body = JSON.parse(readFileSync(pin.path, 'utf8'))
  body.firstLocalReceiptAt = '2026-09-02T00:00:00.000Z'
  const { sha256, ...rest } = body
  void sha256
  body.sha256 = sha(JSON.stringify(rest))
  assert.throws(
    () =>
      validatePinnedMorphoReceiverLead(
        Buffer.from(JSON.stringify(body) + '\n'),
        pin,
        plan.subjects[1],
        plan.subjects[1].candidates[0].owner,
        plan.depositTopic,
      ),
    /lead_file_pin/,
  )
})
test('sender is not silently accepted as the retained Deposit receiver', () => {
  const pin = plan.leadOriginals[2]
  assert.throws(
    () =>
      validatePinnedMorphoReceiverLead(
        readFileSync(pin.path),
        pin,
        plan.subjects[0],
        '0x' + 'de'.repeat(20),
        plan.depositTopic,
      ),
    /lead_absent/,
  )
})
test('header uses canonical block/hash/time only and rejects future clocks', () => {
  const a = {
    result: {
      number: '0x2800',
      hash: source.blockHash,
      timestamp: '0x' + (Date.parse(source.blockTime) / 1000).toString(16),
      transactions: [],
    },
  }
  const b = clone(a)
  b.result.transactions = ['provider_specific_metadata']
  assert.equal(
    sameProbeSource(
      decodeProbeHeader(a, Date.parse(source.blockTime) + 1),
      decodeProbeHeader(b, Date.parse(source.blockTime) + 1),
    ),
    true,
  )
  assert.throws(() => decodeProbeHeader(a, Date.parse(source.blockTime) - 1), /header_clock/)
})
test('native balance and quote calls bind exact source hash without number fallback', () => {
  const request = probeNativeCall('full', plan.subjects[0].vault, 'previewRedeem', [123n], source)
  assert.deepEqual(request.params[1], { blockHash: source.blockHash, requireCanonical: true })
  assert.equal(request.params.length, 2)
})
test('positive native full S and independently decoded full Ea are retained without scaling', () => {
  const s = plan.subjects[0],
    owner = s.candidates[0].owner,
    S = '123456789012345678901234567890',
    Ea = '9876543210987654321'
  const result = derivePairedFundedProbe(fundedRows(s, owner, S, Ea), s, owner, source, hosts)
  assert.equal(result.sharesRaw, S)
  assert.equal(result.fullEaRaw, Ea)
  assert.equal(result.status, 'paired_native_funded_balance')
  assert.equal(result.assetDecimals, 18)
  assert.equal(result.competingMRaw, null)
  assert.equal(result.authenticated, false)
  assert.equal(result.holderExecutableExit, false)
})
test('positive native shares with zero full entitlement remain an observed funded-share result', () => {
  const s = plan.subjects[0],
    owner = s.candidates[0].owner,
    S = '123456789012345678901234567890'
  const result = derivePairedFundedProbe(fundedRows(s, owner, S, '0'), s, owner, source, hosts)
  assert.equal(result.sharesRaw, S)
  assert.equal(result.fullEaRaw, '0')
  assert.equal(result.status, 'paired_native_funded_balance_zero_entitlement')
  assert.equal(result.nativeBalanceObservedAtSource, true)
  assert.equal(result.authenticated, false)
  assert.equal(result.holderExecutableExit, false)
})
test('zero agreed shares skip full previews and do not become funded leads', () => {
  const s = plan.subjects[0],
    owner = s.candidates[0].owner
  const result = derivePairedFundedProbe(fundedRows(s, owner, '0', '123'), s, owner, source, hosts)
  assert.equal(result.status, 'zero_native_balance')
  assert.equal(result.fullEaRaw, null)
  const rows = fundedRows(s, owner, '1', '123')
  rows[0].envelope.result = word(0)
  rows[1].envelope.result = word(0)
  assert.throws(() => derivePairedFundedProbe(rows, s, owner, source, hosts), /zeroS_quote/)
})
test('paired S disagreement never permits a caller-selected share balance', () => {
  const s = plan.subjects[0],
    owner = s.candidates[0].owner,
    rows = fundedRows(s, owner, '10', '20')
  rows[1].envelope.result = word(11)
  assert.throws(() => derivePairedFundedProbe(rows, s, owner, source, hosts), /paired_result/)
})
test('foreign owner or source on a native balance request is rejected', () => {
  const s = plan.subjects[0],
    owner = s.candidates[0].owner,
    rows = fundedRows(s, owner, '10', '20')
  rows[0].request = probeNativeCall(
    rows[0].key,
    s.vault,
    'balanceOf',
    [s.candidates[1].owner],
    source,
  )
  assert.throws(
    () => derivePairedFundedProbe(rows, s, owner, source, hosts),
    /balance_source_request/,
  )
  rows[0].request = probeNativeCall(rows[0].key, s.vault, 'balanceOf', [owner], {
    ...source,
    blockHash: h(999),
  })
  assert.throws(
    () => derivePairedFundedProbe(rows, s, owner, source, hosts),
    /balance_source_request/,
  )
})
test('full quote for a smaller S is rejected rather than linearly expanded', () => {
  const s = plan.subjects[0],
    owner = s.candidates[0].owner,
    rows = fundedRows(s, owner, '10', '20')
  rows[2].request = probeNativeCall(rows[2].key, s.vault, 'previewRedeem', [1n], source)
  assert.throws(() => derivePairedFundedProbe(rows, s, owner, source, hosts), /fullS_quote_request/)
})
test('canonical ABI uint bounds reject malformed output words', () => {
  assert.equal(decodeProbeWord(word((1n << 256n) - 1n)), String((1n << 256n) - 1n))
  assert.throws(() => decodeProbeWord('0x1'), /native_uint_word/)
  assert.throws(() => decodeProbeWord(word(1) + '00'), /native_uint_word/)
})
test('duplicate provider rows cannot stand in for independent origin agreement', () => {
  const rows = [
    { host: hosts[0], key: 'x', envelope: { result: '0x1' } },
    { host: hosts[0], key: 'x', envelope: { result: '0x1' } },
  ]
  assert.throws(() => pairedProbeResult(rows, 'x', hosts), /paired_trace_count/)
})
test('paired native Transfer and Deposit ABI logs produce at most3 distinct receiver leads', () => {
  const rows = [1, 2, 3, 4].map((n) =>
    log({ block: 10230 + n, owner: '0x' + String(n).repeat(40), index: n }),
  )
  const paired = pairProbeLogShard(rows, clone(rows), ausd, plan.transferTopic, 10224, 10240)
  const candidates = probeReceiverCandidates(paired, ausd, ausdExclusions)
  assert.equal(candidates.length, 3)
  assert.equal(candidates[0].owner, '0x' + '4'.repeat(40))
  const d = log({ topic: plan.depositTopic })
  assert.equal(pairProbeLogShard([d], [clone(d)], ausd, plan.depositTopic, 10224, 10240).length, 1)
})
test('vault and exact native adapter selfcustody are excluded before the deterministic top3', () => {
  const valid = ['0x' + 'aa'.repeat(20), '0x' + 'bb'.repeat(20), '0x' + 'ee'.repeat(20)]
  const rows = [...valid, ausd.vault, ausd.liquidityAdapter].map((owner, i) =>
    log({ block: 10230 + i, owner, index: i + 1 }),
  )
  const paired = pairProbeLogShard(rows, clone(rows), ausd, plan.transferTopic, 10224, 10240)
  const candidates = probeReceiverCandidates(paired, ausd, ausdExclusions)
  assert.deepEqual(
    candidates.map((x) => x.owner),
    [...valid].reverse(),
  )
  assert.equal(paired.length, 5)
  assert.equal(candidates.length, 3)
  assert.throws(
    () => probeReceiverCandidates(paired, ausd, [ausd.vault]),
    /candidate_bounds_or_exclusions/,
  )
  assert.throws(
    () => probeReceiverCandidates(paired, ausd, [...ausdExclusions, valid[2]]),
    /candidate_bounds_or_exclusions/,
  )
})
test('removed, foreign-contract, malformed ABI and disagreeing logs cannot become receiver leads', () => {
  for (const change of [
    (x) => {
      x.removed = true
    },
    (x) => {
      x.address = plan.subjects[0].vault
    },
    (x) => {
      x.data = '0x'
    },
    (x) => {
      x.topics[2] = '0x' + 'f'.repeat(64)
    },
  ]) {
    const b = log()
    change(b)
    assert.throws(() => pairProbeLogShard([b], [clone(b)], ausd, plan.transferTopic, 10224, 10240))
  }
  const a = log(),
    b = clone(a)
  b.blockHash = h(777)
  assert.throws(
    () => pairProbeLogShard([a], [b], ausd, plan.transferTopic, 10224, 10240),
    /log_pair_or_order/,
  )
})
test('duplicate or outside-window logs are rejected and zero-share receivers are omitted', () => {
  const a = log()
  assert.throws(
    () => pairProbeLogShard([a, a], [a, a], ausd, plan.transferTopic, 10224, 10240),
    /log_pair_or_order/,
  )
  assert.throws(
    () => pairProbeLogShard([a], [a], ausd, plan.transferTopic, 10200, 10207),
    /log_native_ABI/,
  )
  assert.deepEqual(probeReceiverCandidates([log({ positive: false })], ausd, ausdExclusions), [])
})
test('raw request, response, row commitment and settlement seals join with separate RPC ids', () => {
  const x = oneControl()
  assert.equal(verifyProbeControl(x.receipt, x.requests, x.settlements, 'control-A'), true)
  assert.notEqual(x.receipt.ledger[0].physicalId, x.receipt.ledger[0].request.id)
})
test('future read clocks cannot qualify even after row and settlement resealing', () => {
  const x = oneControl(),
    row = x.receipt.ledger[0]
  row.completedAtUtc = '2026-10-10T08:20:00.001Z'
  x.receipt.terminalCommitments[0].rowSha256 = sha(JSON.stringify(row))
  const { sha256, ...body } = x.settlements[0]
  void sha256
  x.settlements[0].sha256 = sha(JSON.stringify(body))
  assert.throws(
    () => verifyProbeControl(x.receipt, x.requests, x.settlements, 'control-A'),
    /native_row_clock/,
  )
})
test('changed raw response or request bytes cannot be blessed by outer receipts', () => {
  const a = oneControl()
  a.requests[0].requestBodyBase64 = Buffer.from('{}').toString('base64')
  assert.throws(
    () => verifyProbeControl(a.receipt, a.requests, a.settlements, 'control-A'),
    /native_raw_join/,
  )
  const b = oneControl()
  b.receipt.ledger[0].rawBodyBase64 = Buffer.from('{}').toString('base64')
  assert.throws(() => verifyProbeControl(b.receipt, b.requests, b.settlements, 'control-A'))
})
test('mutated settlement or a pending/failed control never qualifies', () => {
  const a = oneControl()
  a.settlements[0].captureAcceptance = true
  assert.throws(
    () => verifyProbeControl(a.receipt, a.requests, a.settlements, 'control-A'),
    /settlement_join/,
  )
  const b = oneControl()
  b.receipt.pendingSettlements = 1
  assert.throws(
    () => verifyProbeControl(b.receipt, b.requests, b.settlements, 'control-A'),
    /control_complete/,
  )
})
test('privacy rejects Unicode-escaped credential keys/values and escaped malformed responses', () => {
  const secret = 'fixture-secret-42',
    escaped = [...secret].map((x) => '\\u' + x.charCodeAt(0).toString(16).padStart(4, '0')).join('')
  for (const text of [
    '{"' + escaped + '":"safe"}',
    '{"error":{"message":"' + escaped + '"}}',
    '{"x":"' + escaped + '"',
  ]) {
    assert.throws(() =>
      assertFundedHolderProbePrivacy({ rawBodyBase64: Buffer.from(text).toString('base64') }, [
        secret,
      ]),
    )
  }
  assert.equal(
    assertFundedHolderProbePrivacy({ rawBodyBase64: Buffer.from('{broken').toString('base64') }, [
      secret,
    ]),
    true,
  )
})
test('privacy rejects accessors, cycles and secret-list getters without evaluation', () => {
  let calls = 0
  const input = Object.defineProperty({}, 'x', {
    enumerable: true,
    get() {
      calls++
      throw Error('getter')
    },
  })
  assert.throws(() => assertFundedHolderProbePrivacy(input, ['fixture-secret-42']))
  const secrets = []
  Object.defineProperty(secrets, '0', {
    enumerable: true,
    get() {
      calls++
      return 'fixture-secret-42'
    },
  })
  assert.throws(() => assertFundedHolderProbePrivacy({}, secrets))
  const cycle = {}
  cycle.x = cycle
  assert.throws(() => assertFundedHolderProbePrivacy(cycle, ['fixture-secret-42']))
  assert.equal(calls, 0)
})
test('failed fsync still charges the attempted file and creates no successful reference', () => {
  const { writer, state } = mockedWriter({ failFsync: true }),
    body = { kind: 'attempt' }
  assert.throws(() => writer.write('attempt.json', body), /mock_fsync_fail/)
  const attempted = Buffer.byteLength(JSON.stringify(body) + '\n')
  assert.equal(writer.used(), attempted)
  assert.equal(writer.refs.length, 0)
  state.failFsync = false
  writer.write('terminal.json', { status: 'partial' }, true)
  assert.equal(writer.refs.length, 1)
  assert.ok(writer.used() > attempted)
})
test('terminal and file serialization limits reject before opening any output file', () => {
  const { writer, state } = mockedWriter(),
    opens = state.opens
  assert.throws(() => writer.write('terminal.json', Buffer.alloc(65537), true), /write_cap/)
  assert.equal(state.opens, opens)
  assert.equal(writer.used(), 0)
  assert.throws(() => writer.write('../escape.json', {}), /artifact_name/)
  assert.equal(state.opens, opens)
})
test('fresh module import starts no origins, native reads, timers or CLI', async () => {
  const fetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    throw Error('unexpected_native_read')
  }
  try {
    await import('../../scripts/research/morpho-observed-funded-holder-probe.mjs?inert=control')
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = fetch
  }
})

function mockNative({ stalledLogs = false, emptyLogs = false, adapterError = false } = {}) {
  let time = 0,
    fetches = 0
  const nativeSource = { ...source, blockHash: h(10240) },
    base = Date.parse('2026-10-09T08:20:00.000Z')
  const now = () => base + time,
    monotonic = () => time,
    pace = async (n) => {
      time += n
    }
  const origins = hosts.map((host) => ({ host, url: 'https://' + host + '/rpc/fixture-secret-42' }))
  const fetcher = async (_url, options) => {
    assert.equal(options.redirect, 'error')
    fetches++
    time++
    const req = JSON.parse(options.body)
    let result
    if (req.method === 'eth_chainId') result = '0x1'
    else if (req.method === 'eth_getBlockByNumber') {
      const b = req.params[0] === 'finalized' ? 10240 : Number(BigInt(req.params[0]))
      result = {
        number: '0x' + b.toString(16),
        hash: h(b),
        timestamp: '0x' + (Date.parse(source.blockTime) / 1000 - (10240 - b) * 12).toString(16),
        transactions: [],
      }
    } else if (req.method === 'eth_getCode') result = '0x60006000'
    else if (req.method === 'eth_getLogs') {
      if (stalledLogs) return new Promise(() => {})
      const q = req.params[0],
        b = Number(BigInt(q.toBlock)),
        owner = '0x' + ['aa', 'bb', 'cc'][b % 3].repeat(20)
      result = emptyLogs
        ? []
        : [
            log({
              block: b,
              owner,
              topic: q.topics[0],
              index: q.topics[0] === plan.depositTopic ? 1 : 2,
            }),
          ]
    } else {
      assert.equal(req.method, 'eth_call')
      assert.deepEqual(req.params[1], { blockHash: nativeSource.blockHash, requireCanonical: true })
      const { to, data } = req.params[0],
        s = plan.subjects.find((s) => s.vault === to || s.asset === to)
      if (
        data ===
        probeNativeCall('adapter', plan.subjects[2].vault, 'liquidityAdapter', [], nativeSource)
          .params[0].data
      ) {
        if (adapterError)
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              error: { code: 3, message: 'native_error' },
            }),
            { status: 200 },
          )
        result = addressWord(ausd.liquidityAdapter)
      } else if (data === '0x38d52e0f') result = addressWord(s.asset)
      else if (data === '0x313ce567') result = word(to === s.vault ? 18 : s.assetDecimals)
      else if (data.startsWith('0x70a08231'))
        result = word(
          data.endsWith(plan.subjects[0].candidates[0].owner.slice(2)) ? 0 : 1234567890123456789n,
        )
      else if (data.startsWith('0x4cdad506')) result = word(987654321)
      else assert.fail('unexpected native function')
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { origins, options: { fetcher, now, monotonic, pace }, fetches: () => fetches }
}
test('controlled raw current probe obeys the closed budget and validates independent full previews', async () => {
  const prepared = prepareMorphoObservedFundedHolderProbe(),
    mock = mockNative()
  const result = await captureMorphoObservedFundedHolderProbe(prepared, mock.origins, mock.options)
  assert.equal(result.complete, true, result.failure)
  assert.equal(result.physicalStarts, mock.fetches())
  assert.ok(result.physicalStarts <= 106)
  assert.equal(result.logs.receipt.physicalStarts, 32)
  assert.ok(result.default.receipt.physicalStarts <= 74)
  assert.equal(result.outputs.length, 7)
  assert.equal(result.outputs.filter((x) => x.status === 'zero_native_balance').length, 1)
  assert.ok(
    result.outputs
      .filter((x) => x.status === 'paired_native_funded_balance')
      .every((x) => x.fullEaRaw === '987654321'),
  )
  assert.equal(result.default.requests.length, result.default.receipt.physicalStarts)
  assert.equal(result.logs.requests.length, 32)
  assert.equal(result.discovery.nativeConfiguredAdapter, ausd.liquidityAdapter)
  assert.deepEqual(result.discovery.excludedReceivers, ausdExclusions)
  assert.equal(result.discovery.fundedReceiverCount, 3)
})
test('an empty paired recent AUSD window remains unresolved without extending discovery', async () => {
  const prepared = prepareMorphoObservedFundedHolderProbe(),
    mock = mockNative({ emptyLogs: true })
  const result = await captureMorphoObservedFundedHolderProbe(prepared, mock.origins, mock.options)
  assert.equal(result.complete, true, result.failure)
  assert.equal(result.discovery.sourceBlockFrom, '10177')
  assert.equal(result.discovery.sourceBlockTo, '10240')
  assert.equal(result.discovery.completedShards, 8)
  assert.equal(result.discovery.pairedNativeLogCount, 0)
  assert.equal(result.discovery.selectedReceiverCount, 0)
  assert.equal(result.discovery.fundedReceiverCount, 0)
  assert.equal(result.discovery.status, 'no_receiver_leads_in_bounded_window')
  assert.equal(result.discovery.universalNoHolderClaim, false)
  assert.equal(result.discovery.holderAvailabilityClaimed, false)
  assert.equal(result.logs.receipt.physicalStarts, 32)
  assert.equal(result.outputs.length, 4)
  assert.ok(result.physicalStarts <= 106)
})
test('failed current native adapter getter leaves AUSD unresolved without an old-adapter fallback', async () => {
  const prepared = prepareMorphoObservedFundedHolderProbe(),
    mock = mockNative({ adapterError: true })
  const result = await captureMorphoObservedFundedHolderProbe(prepared, mock.origins, mock.options)
  assert.equal(result.complete, false)
  assert.equal(result.discovery.status, 'incomplete')
  assert.equal(result.discovery.nativeConfiguredAdapter, null)
  assert.equal(result.discovery.excludedReceivers, null)
  assert.equal(result.discovery.selectedReceiverCount, 0)
  assert.equal(result.logs.receipt.physicalStarts, 0)
  assert.equal(result.outputs.length, 4)
  assert.ok(result.physicalStarts <= 106)
})
test(
  'stalled separate log transport has a hard read timeout and cannot qualify pending settlements',
  { timeout: 12000 },
  async () => {
    const prepared = prepareMorphoObservedFundedHolderProbe(),
      mock = mockNative({ stalledLogs: true })
    const result = await captureMorphoObservedFundedHolderProbe(
      prepared,
      mock.origins,
      mock.options,
    )
    assert.equal(result.complete, false)
    assert.match(result.failure, /log_timeout/)
    assert.ok(result.logs.receipt.pendingSettlements > 0)
    assert.ok(result.physicalStarts <= 106)
  },
)


test('privacy permits only opted named native headers through 256 KiB and keeps legacy Base64 caps', () => {
  const request = { jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['finalized', false] }
  const make = (length) => ({ request, nativeHeaderRole: {
    key: 'fresh_finalized', method: request.method, role: 'native_header' },
    rawBodyBase64: Buffer.from('{"result":null}' + ' '.repeat(length - Buffer.byteLength('{"result":null}'))).toString('base64') })
  const header = make(262144)
  assert.equal(Buffer.from(header.rawBodyBase64, 'base64').length, 262144)
  assert.equal(assertFundedHolderProbePrivacy(header, ['unseen-secret'], MORPHO_NATIVE_HEADER_RESPONSE_POLICY), true)
  assert.throws(() => assertFundedHolderProbePrivacy(header, ['unseen-secret']), /header_role_binding/)
  assert.throws(() => assertFundedHolderProbePrivacy(make(262145), ['unseen-secret'], MORPHO_NATIVE_HEADER_RESPONSE_POLICY), /privacy_raw/)
  assert.throws(() => assertFundedHolderProbePrivacy({ rawBodyBase64: Buffer.alloc(65537).toString('base64') }, ['unseen-secret']), /privacy_raw/)
  let invoked = false
  const role = Object.defineProperty({}, 'key', { enumerable: true, get() { invoked = true; return 'fresh_finalized' } })
  assert.throws(() => assertFundedHolderProbePrivacy({ request, nativeHeaderRole: role, rawBodyBase64: '' }, ['unseen-secret'], MORPHO_NATIVE_HEADER_RESPONSE_POLICY), /json_descriptor/)
  assert.equal(invoked, false)
})
