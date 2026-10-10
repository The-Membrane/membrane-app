import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { chmodSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import {
  assertHistoricalQuoteWriteCapacity,
  appendHistoricalQuoteAnchorFailure,
  appendHistoricalQuoteAttempt,
  appendHistoricalQuoteSetupFailure,
  acquireHistoricalQuoteWriterLock,
  isValidSuccessfulHistoricalQuoteTrace,
  MIN_HISTORICAL_QUOTE_FREE_BYTES,
  listHistoricalQuoteAttempts,
  readHistoricalQuoteAnchor,
  readHistoricalQuoteAnchorFailures,
  readHistoricalQuoteRoster,
  readHistoricalQuoteSetupFailures,
  writeHistoricalQuoteAnchor,
  writeHistoricalQuoteRoster,
  isValidHistoricalQuoteHeaderProjection,
  readHistoricalQuoteAttempts,
  resolveHistoricalQuoteCaptures,
  historicalQuoteCaptureSha256,
  encodeHistoricalQuoteCapture,
  decodeHistoricalQuoteCapture,
  MAX_HISTORICAL_QUOTE_CAPTURE_BYTES,
} from './historicalDepthQuoteStore.mjs'

const ampleDisk = () => ({ bavail: 2_000_000, bsize: 4096 })
const hash = (text) => createHash('sha256').update(text).digest('hex')
const providers = [
  { host: 'archive-one.example', uriSha256: hash('url-one') },
  { host: 'archive-two.example', uriSha256: hash('url-two') },
]
const venues = ['sUSDe', 'sUSDS', 'scrvUSD'].map((name) => ({
  name,
  configIdentity: hash(name),
  marketIdentities: { market: hash(`${name}-market`) },
}))
const anchors = Array.from({ length: 120 }, (_, index) => {
  const day = new Date(Date.UTC(2026, 5, 10 + index)).toISOString().slice(0, 10)
  return day
})

test('projected anchor header contract rejects extra fields, unbounded values and mismatched requests', () => {
  const entry = {
    evidenceType: 'block_header_projection_v1', fullResponseSha256: hash('wire'), fullResponseBytes: 35000,
    request: { jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['0x1', false] },
    response: { jsonrpc: '2.0', id: 1, result: {
      number: '0x1', hash: `0x${'a'.repeat(64)}`, parentHash: `0x${'b'.repeat(64)}`, timestamp: '0x123',
    } },
  }
  assert.equal(isValidHistoricalQuoteHeaderProjection(entry), true)
  for (const patch of [
    { evidenceType: 'raw' }, { fullResponseBytes: 2 * 1024 * 1024 }, { fullResponseSha256: 'invalid' },
    { request: { ...entry.request, params: ['0x2', false] } },
    { response: { ...entry.response, id: 2 } },
    { response: { ...entry.response, result: { ...entry.response.result, transactions: [] } } },
    { response: { ...entry.response, result: { ...entry.response.result, timestamp: `0x${'1'.repeat(1000)}` } } },
    { response: { ...entry.response, result: { ...entry.response.result, parentHash: '0x1' } } },
    { fullResponseSha256: [entry.fullResponseSha256] },
    { request: { ...entry.request, params: [['0x1'], false] } },
    { request: { ...entry.request, params: ['0x01', false] } },
    ...['number', 'timestamp', 'hash', 'parentHash'].flatMap((key) => [
      { response: { ...entry.response, result: { ...entry.response.result, [key]: [entry.response.result[key]] } } },
      { response: { ...entry.response, result: { ...entry.response.result, [key]: {} } } },
    ]),
    { response: { ...entry.response, result: { ...entry.response.result, number: '0x01' } } },
    { response: { ...entry.response, result: { ...entry.response.result, timestamp: '0x0123' } } },
  ]) assert.equal(isValidHistoricalQuoteHeaderProjection({ ...entry, ...patch }), false)
})

function withRoot(run) {
  const root = mkdtempSync(join(tmpdir(), 'historical-depth-quotes-test-'))
  try {
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function roster(root) {
  return writeHistoricalQuoteRoster(
    { createdAtUtc: '2026-10-07T12:00:00.000Z', anchors, venues, providers },
    { root, stat: ampleDisk },
  )
}

test('daily quote roster is immutable, versioned and binds exact providers/config identities', () =>
  withRoot((root) => {
    const first = roster(root)
    assert.equal(readHistoricalQuoteRoster(first.rosterId, { root }).sha256, first.sha256)
    assert.throws(
      () =>
        writeHistoricalQuoteRoster(
          {
            createdAtUtc: '2026-10-07T12:00:00.000Z',
            anchors,
            venues,
            providers: [providers[0], providers[0]],
          },
          { root, stat: ampleDisk },
        ),
      /roster_invalid/,
    )
    assert.throws(
      () =>
        writeHistoricalQuoteRoster(
          {
            createdAtUtc: '2026-10-07T12:00:00.000Z',
            anchors,
            venues,
            providers: [{ ...providers[0], host: 'archive-one.example.' }, providers[1]],
          },
          { root, stat: ampleDisk },
        ),
      /roster_invalid/,
    )
  }))

test('successful raw proof requires paired JSON-RPC envelopes and exact response ids', () => {
  const trace = [
    {
      request: { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{}, '0x1'] },
      response: { jsonrpc: '2.0', id: 1, result: '0x' },
    },
  ]
  assert.equal(isValidSuccessfulHistoricalQuoteTrace(trace), true)
  assert.equal(
    isValidSuccessfulHistoricalQuoteTrace([
      { ...trace[0], response: { jsonrpc: '2.0', id: 2, result: '0x' } },
    ]),
    false,
  )
  assert.equal(
    isValidSuccessfulHistoricalQuoteTrace([
      {
        ...trace[0],
        response: { jsonrpc: '2.0', id: 1, result: '0x', error: { code: -1, message: 'x' } },
      },
    ]),
    false,
  )
  assert.equal(isValidSuccessfulHistoricalQuoteTrace([{ method: 'eth_call', result: '0x' }]), false)
})

test('writer ownership is exclusive, kernel released, and cleans only bounded recognized temp files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'historical-depth-lock-test-'))
  try {
    const release = await acquireHistoricalQuoteWriterLock(root)
    await assert.rejects(acquireHistoricalQuoteWriterLock(root), /writer_busy/)
    const orphan = join(
      root,
      `roster-test.json.${'a'.repeat(8)}-${'b'.repeat(4)}-${'c'.repeat(4)}-${'d'.repeat(4)}-${'e'.repeat(12)}.tmp`,
    )
    writeFileSync(orphan, '{partial')
    await release()
    const recoveredRelease = await acquireHistoricalQuoteWriterLock(root)
    assert.equal(existsSync(orphan), false)
    await recoveredRelease()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  assert.equal(MIN_HISTORICAL_QUOTE_FREE_BYTES, 1_342_177_280)
})

test('kernel releases writer ownership after the recorder process is killed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'historical-depth-killed-owner-test-'))
  const moduleUrl = new URL('./historicalDepthQuoteStore.mjs', import.meta.url).href
  const source = `const { acquireHistoricalQuoteWriterLock } = await import(${JSON.stringify(moduleUrl)}); await acquireHistoricalQuoteWriterLock(${JSON.stringify(root)}); console.log('ready'); setInterval(() => {}, 1000)`
  const owner = spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const lines = createInterface({ input: owner.stdout })
  try {
    await new Promise((resolve, reject) => {
      lines.once('line', resolve)
      owner.once('error', reject)
      owner.once('exit', (code) => reject(new Error(`owner_exited_${code}`)))
    })
    owner.kill('SIGKILL')
    await once(owner, 'exit')
    const release = await acquireHistoricalQuoteWriterLock(root)
    await release()
  } finally {
    owner.kill('SIGKILL')
    lines.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('lock stays owned by the live Node descriptor if the short-lived helper is killed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'historical-depth-killed-helper-test-'))
  const python = join(root, 'python-lock-helper')
  writeFileSync(
    python,
    '#!/usr/bin/python3\nimport fcntl, os, signal\nfcntl.flock(3, fcntl.LOCK_EX|fcntl.LOCK_NB)\nprint("LOCKED", flush=True)\nos.kill(os.getpid(), signal.SIGKILL)\n',
  )
  chmodSync(python, 0o700)
  try {
    const release = await acquireHistoricalQuoteWriterLock(root, { python })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.doesNotThrow(release.assertHeld)
    await assert.rejects(acquireHistoricalQuoteWriterLock(root), /writer_busy/)
    await release()
    const recovered = await acquireHistoricalQuoteWriterLock(root)
    await recovered()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('provider setup failures persist without storing endpoint credentials', () =>
  withRoot((root) => {
    appendHistoricalQuoteSetupFailure('two_archive_hosts_required', {
      root,
      stat: ampleDisk,
      now: () => new Date('2026-10-07T12:00:00.000Z'),
    })
    const failures = readHistoricalQuoteSetupFailures({ root })
    assert.equal(failures.length, 1)
    assert.equal(failures[0].reason, 'two_archive_hosts_required')
    assert.ok(!JSON.stringify(failures).includes('https://'))
  }))

test('anchor stores raw selected-header evidence and separate source versus receipt clocks', () =>
  withRoot((root) => {
    const savedRoster = roster(root)
    const day = anchors[0]
    const blockTime = '2026-06-10T00:00:00.000Z'
    const headerEvidence = [
      {
        request: {
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getBlockByNumber',
          params: ['0x1', false],
        },
        response: {
          jsonrpc: '2.0',
          id: 1,
          result: {
            number: '0x1',
            hash: `0x${'a'.repeat(64)}`,
            timestamp: `0x${Math.floor(Date.parse(blockTime) / 1000).toString(16)}`,
          },
        },
      },
    ]
    const record = writeHistoricalQuoteAnchor(
      savedRoster.rosterId,
      {
        day,
        targetAtUtc: `${day}T00:00:00.000Z`,
        selectedProviderId: providers[0].host,
        block: '1',
        blockHash: `0x${'a'.repeat(64)}`,
        blockTimeUtc: blockTime,
        offsetSeconds: 0,
        headerEvidence,
      },
      { root, stat: ampleDisk },
    )
    assert.deepEqual(readHistoricalQuoteAnchor(savedRoster.rosterId, day, { root }), record)
    assert.equal(record.blockTimeUtc, blockTime)
    assert.ok(Date.parse(record.firstLocalReceiptAtUtc) > Date.parse(blockTime))
  }))

test('typed anchor and provider failures remain append-only and count toward bounded retries', () =>
  withRoot((root) => {
    const savedRoster = roster(root)
    const day = anchors[0]
    appendHistoricalQuoteAnchorFailure(
      savedRoster.rosterId,
      day,
      { reason: 'archive_window_pruned', evidence: { starts: 23 } },
      { root, stat: ampleDisk, now: () => new Date('2026-10-07T12:01:00.000Z') },
    )
    assert.equal(
      readHistoricalQuoteAnchorFailures(savedRoster.rosterId, day, { root })[0].reason,
      'archive_window_pruned',
    )

    writeHistoricalQuoteAnchor(
      savedRoster.rosterId,
      {
        day,
        targetAtUtc: `${day}T00:00:00.000Z`,
        selectedProviderId: providers[0].host,
        block: '1',
        blockHash: `0x${'a'.repeat(64)}`,
        blockTimeUtc: `${day}T00:00:00.000Z`,
        offsetSeconds: 0,
        headerEvidence: [],
      },
      { root, stat: ampleDisk },
    )
    appendHistoricalQuoteAttempt(
      savedRoster.rosterId,
      'sUSDe',
      day,
      {
        rosterId: savedRoster.rosterId,
        anchorDay: day,
        venue: 'sUSDe',
        status: 'failed',
        reason: 'provider_timeout',
        captures: [],
      },
      { root, stat: ampleDisk, now: () => new Date('2026-10-07T12:02:00.000Z') },
    )
    const attempts = listHistoricalQuoteAttempts(savedRoster.rosterId, { root })
    assert.equal(attempts.length, 1)
    assert.equal(attempts[0].reason, 'provider_timeout')
    assert.ok(Date.parse(attempts[0].firstLocalReceiptAtUtc) > Date.parse(`${day}T00:00:00.000Z`))
  }))

function referenceFixture(root) {
  const saved = writeHistoricalQuoteRoster({ createdAtUtc: '2026-10-07T12:00:00.000Z', anchors,
    providers, venues: venues.map((venue) => ({ ...venue, markets: [{ name: 'market' }] })) }, { root, stat: ampleDisk })
  const venue = saved.venues[0]
  const day = anchors[0], time = `${day}T00:00:00.000Z`, blockHash = `0x${'a'.repeat(64)}`
  writeHistoricalQuoteAnchor(saved.rosterId, { day, targetAtUtc: time, block: '1',
    blockHash, blockTimeUtc: time, offsetSeconds: 0, selectedProviderId: providers[0].host,
    headerEvidence: [] }, { root, stat: ampleDisk })
  const complete = {
    ...providers[0], reason: null, code: {}, startedAtUtc: `${day}T01:00:00.000Z`, completedAtUtc: `${day}T01:01:00.000Z`,
    rawRpcTrace: ['eth_getCode', 'eth_getStorageAt', 'eth_call'].map((method, index) => ({
      request: { jsonrpc: '2.0', id: index + 1, method, params: [] },
      response: { jsonrpc: '2.0', id: index + 1, result: '0x1' },
    })),
    output: { nav: { usd: 1 }, markets: [{ market: 'market', configIdentity: venue.marketIdentities.market,
      points: [0.1, 0.25, 0.5, 1, 2, 5, 10].map((costPct) => ({ costPct, capacityUsd: costPct })) }] },
  }
  const body = { rosterId: saved.rosterId, venue: venue.name, anchorDay: day, status: 'failed', reason: 'provider_rpc_internal_error',
    configIdentity: venue.configIdentity, marketIdentities: venue.marketIdentities,
    source: { block: '1', hash: blockHash, time, offsetSeconds: 0 }, levels: [0.1, 0.25, 0.5, 1, 2, 5, 10],
    captures: [complete, { ...providers[1], reason: 'provider_rpc_internal_error', rawRpcTrace: [] }] }
  const source = appendHistoricalQuoteAttempt(saved.rosterId, venue.name, day, body, { root, stat: ampleDisk })
  const reference = { evidenceType: 'capture_reference_v1', sourceAttemptSequence: 1, sourceAttemptSha256: source.sha256,
    captureIndex: 0, captureSha256: historicalQuoteCaptureSha256(complete) }
  const append = (entry = reference, patch = {}) => appendHistoricalQuoteAttempt(saved.rosterId, venue.name, day,
    { ...body, ...patch, captures: [entry, body.captures[1]] }, { root, stat: ampleDisk })
  return { saved, venue, day, complete, source, reference, append }
}

const codecEnvelope = (raw, compressed = deflateRawSync(raw)) => ({
  evidenceType: 'complete_capture_deflate_raw_v1', contentSha256: hash(raw),
  uncompressedBytes: raw.length, compressedSha256: hash(compressed), payload: compressed.toString('base64'),
})

test('complete capture codec preserves exact JSON bytes, original capture hash and all RPC evidence', () => withRoot((root) => {
  const { complete } = referenceFixture(root)
  complete.rawRpcTrace[0].response.result = `0x${'60'.repeat(30000)}`
  const encoded = encodeHistoricalQuoteCapture(complete)
  assert.equal(encoded.evidenceType, 'complete_capture_deflate_raw_v1')
  assert.ok(Buffer.byteLength(JSON.stringify(encoded)) < Buffer.byteLength(JSON.stringify(complete)))
  const decoded = decodeHistoricalQuoteCapture(encoded)
  assert.equal(JSON.stringify(decoded), JSON.stringify(complete))
  assert.equal(historicalQuoteCaptureSha256(decoded), encoded.contentSha256)
  assert.equal(encoded.uncompressedBytes, Buffer.byteLength(JSON.stringify(complete)))
  assert.deepEqual(decoded.rawRpcTrace, complete.rawRpcTrace)
  const tiny = { reason: null, rawRpcTrace: [] }
  assert.equal(encodeHistoricalQuoteCapture(tiny), tiny)
  assert.throws(() => encodeHistoricalQuoteCapture({ ...complete, reason: 'http_429' }), /capture_codec_source_invalid/)
  assert.throws(() => encodeHistoricalQuoteCapture({ ...complete, padding: 'x'.repeat(MAX_HISTORICAL_QUOTE_CAPTURE_BYTES) }),
    /evidence_over_limit_individual_capture/)
}))

test('capture codec rejects malformed primitive schema, base64, commitments and exact length drift', () => withRoot((root) => {
  const { complete } = referenceFixture(root), encoded = encodeHistoricalQuoteCapture(complete)
  for (const patch of [
    { extra: true }, { payload: [encoded.payload] }, { contentSha256: [encoded.contentSha256] },
    { compressedSha256: [encoded.compressedSha256] }, { uncompressedBytes: [encoded.uncompressedBytes] },
    { uncompressedBytes: 0 }, { uncompressedBytes: MAX_HISTORICAL_QUOTE_CAPTURE_BYTES + 1 },
    { uncompressedBytes: encoded.uncompressedBytes + 1 }, { contentSha256: '0'.repeat(64) },
    { compressedSha256: '0'.repeat(64) }, { payload: encoded.payload + '\n' }, { payload: '%%%%' },
    { payload: '' }, { evidenceType: 'complete_capture_gzip_v1' },
  ]) assert.throws(() => decodeHistoricalQuoteCapture({ ...encoded, ...patch }), /capture_codec_invalid/)
}))

test('capture codec rejects trailing and concatenated streams, decompression bombs and noncanonical JSON', () => withRoot((root) => {
  const { complete } = referenceFixture(root), raw = Buffer.from(JSON.stringify(complete))
  const compressed = deflateRawSync(raw)
  for (const bytes of [Buffer.concat([compressed, Buffer.from([1, 2, 3])]), Buffer.concat([compressed, compressed])])
    assert.throws(() => decodeHistoricalQuoteCapture(codecEnvelope(raw, bytes)), /capture_codec_invalid/)
  const bomb = Buffer.alloc(MAX_HISTORICAL_QUOTE_CAPTURE_BYTES + 1, 0)
  assert.throws(() => decodeHistoricalQuoteCapture({ ...codecEnvelope(bomb), uncompressedBytes: MAX_HISTORICAL_QUOTE_CAPTURE_BYTES }),
    /capture_codec_invalid/)
  for (const bytes of [Buffer.from(JSON.stringify(complete) + ' '), Buffer.from('{"reason":null,"reason":null,"rawRpcTrace":[]}'),
    Buffer.from(JSON.stringify({ ...complete, reason: 'http_429' }))])
    assert.throws(() => decodeHistoricalQuoteCapture(codecEnvelope(bytes)), /capture_codec_invalid/)
}))

test('version three concrete sources support one-hop decoded-hash references and keep legacy records unchanged', () => withRoot((root) => {
  const f = referenceFixture(root)
  const { sha256: _sha, sequence: _seq, study: _study, firstLocalReceiptAtUtc: _clock, ...base } = f.source
  const source = appendHistoricalQuoteAttempt(f.saved.rosterId, f.venue.name, f.day,
    { ...base, captures: [encodeHistoricalQuoteCapture(f.complete)] }, { root, stat: ampleDisk })
  assert.equal(source.study, 'historical-depth-quote-attempt-v3')
  const reference = { ...f.reference, sourceAttemptSequence: source.sequence, sourceAttemptSha256: source.sha256 }
  const paired = appendHistoricalQuoteAttempt(f.saved.rosterId, f.venue.name, f.day,
    { ...base, status: 'verified', reason: null, captures: [reference,
      encodeHistoricalQuoteCapture({ ...f.complete, ...providers[1] })] }, { root, stat: ampleDisk })
  assert.equal(paired.study, 'historical-depth-quote-attempt-v3')
  assert.deepEqual(resolveHistoricalQuoteCaptures(paired, { root })[0], f.complete)
  const rows = readHistoricalQuoteAttempts(f.saved.rosterId, f.venue.name, f.day, { root })
  assert.equal(rows[0].sha256, f.source.sha256)
  assert.equal(rows[0].study, 'historical-depth-quote-attempt-v1')
  assert.throws(() => appendHistoricalQuoteAttempt(f.saved.rosterId, f.venue.name, f.day,
    { ...base, captures: [{ ...reference, sourceAttemptSequence: paired.sequence, sourceAttemptSha256: paired.sha256 }] },
    { root, stat: ampleDisk }), /capture_reference_proof_mismatch/)
}))

test('legacy study tags cannot disguise compressed concrete evidence', () => withRoot((root) => {
  const f = referenceFixture(root)
  const { sha256: _sha, sequence: _seq, study: _study, firstLocalReceiptAtUtc: _clock, ...base } = f.source
  const record = appendHistoricalQuoteAttempt(f.saved.rosterId, f.venue.name, f.day,
    { ...base, captures: [encodeHistoricalQuoteCapture(f.complete)] }, { root, stat: ampleDisk })
  const { sha256: _seal, ...body } = record
  for (const study of ['historical-depth-quote-attempt-v1', 'historical-depth-quote-attempt-v2']) {
    const changed = { ...body, study }; changed.sha256 = hash(JSON.stringify(changed))
    writeFileSync(join(root, `roster-${f.saved.rosterId}`, 'records', f.venue.name, f.day, 'attempt-02.json'), JSON.stringify(changed) + '\n')
    assert.throws(() => readHistoricalQuoteAttempts(f.saved.rosterId, f.venue.name, f.day, { root }), /capture_codec_version_invalid/)
  }
}))

test('version two references resolve complete evidence inside failed sources without rewriting legacy records', () => withRoot((root) => {
  const fixture = referenceFixture(root)
  assert.equal(fixture.source.study, 'historical-depth-quote-attempt-v1')
  const next = fixture.append()
  assert.equal(next.study, 'historical-depth-quote-attempt-v2')
  assert.deepEqual(resolveHistoricalQuoteCaptures(next, { root })[0], fixture.complete)
  assert.deepEqual(readHistoricalQuoteAttempts(fixture.saved.rosterId, fixture.venue.name, fixture.day, { root })[0], fixture.source)
}))

test('reference schema rejects later, self, foreign, malformed hashes, paths, indexes and current identity mismatch', () => withRoot((root) => {
  const { reference, append, saved, source, day } = referenceFixture(root)
  for (const patch of [
    { sourceAttemptSequence: 2 }, { sourceAttemptSequence: 3 }, { sourceAttemptSequence: 0 },
    { sourceAttemptSequence: [1] }, { sourceAttemptSha256: 'f'.repeat(64) },
    { sourceAttemptSha256: [reference.sourceAttemptSha256] }, { captureSha256: 'f'.repeat(64) },
    { captureSha256: [reference.captureSha256] }, { captureIndex: 1 }, { captureIndex: 2 },
    { captureIndex: [0] }, { path: '/tmp/foreign.json' }, { day: anchors[1] }, { evidenceType: 'capture_reference_v2' },
  ]) assert.throws(() => append({ ...reference, ...patch }))
  assert.throws(() => append(reference, { configIdentity: 'f'.repeat(64) }), /capture_identity_mismatch/)
  assert.throws(() => append(reference, { source: { block: '2' } }), /capture_identity_mismatch/)
  const foreignVenue = saved.venues[1]
  const foreign = appendHistoricalQuoteAttempt(saved.rosterId, foreignVenue.name, day,
    { ...source, venue: foreignVenue.name, configIdentity: foreignVenue.configIdentity,
      marketIdentities: foreignVenue.marketIdentities }, { root, stat: ampleDisk })
  assert.throws(() => append({ ...reference, sourceAttemptSha256: foreign.sha256 }), /capture_reference_source_mismatch/)
}))

test('references never follow another reference and reject missing immutable source files', () => withRoot((root) => {
  const { saved, venue, day, reference, append } = referenceFixture(root)
  const second = append()
  assert.throws(() => append({ ...reference, sourceAttemptSequence: 2, sourceAttemptSha256: second.sha256,
    captureSha256: historicalQuoteCaptureSha256(second.captures[0]) }), /capture_reference_proof_mismatch/)
  rmSync(join(root, `roster-${saved.rosterId}`, 'records', venue.name, day, 'attempt-01.json'))
  assert.throws(() => resolveHistoricalQuoteCaptures(second, { root }))
}))


test('aggregate storage reservation protects all three bounded records and rejects invalid byte policies',()=>{
 const root=mkdtempSync(join(tmpdir(),'depth-storage-reservation-'))
 try {
  assertHistoricalQuoteWriteCapacity(3*512*1024,{root,stat:ampleDisk})
  const marginal=()=>({bavail:MIN_HISTORICAL_QUOTE_FREE_BYTES+512*1024,bsize:1})
  assert.throws(()=>assertHistoricalQuoteWriteCapacity(3*512*1024,{root,stat:marginal}),/disk_reserve/)
  writeFileSync(join(root,'occupied.json'),'x')
  assert.throws(()=>assertHistoricalQuoteWriteCapacity(128*1024*1024,{root,stat:ampleDisk}),/archive_byte_cap/)
  for(const n of [0,-1,1.5,'1572864',Infinity,129*1024*1024])
   assert.throws(()=>assertHistoricalQuoteWriteCapacity(n,{root,stat:ampleDisk}),/storage_reservation_invalid/)
 }finally{rmSync(root,{recursive:true,force:true})}
})
