import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  probeMorphoMissingCapture,
  readMorphoMissingReceipt,
  writeMorphoMissingReceipt,
} from './record-carry-morpho-exit-v2-missing.mjs'

const row = {
  caseId: '42',
  horizonH: 4,
  targetAt: '2026-09-30T04:00:00.123456Z',
  deadlineAt: '2026-09-30T06:00:00.123456Z',
}
const client = (url, response) => ({
  url,
  provider: new URL(url).origin,
  send: async (request) => {
    assert.equal(request.method, 'eth_getBlockByNumber')
    assert.deepEqual(request.params, ['finalized', false])
    return response
  },
})
const failed = (url) =>
  client(url, {
    jsonrpc: '2.0',
    id: 91,
    error: { code: -32000, message: 'header temporarily unavailable' },
  })
const success = (url) =>
  client(url, {
    jsonrpc: '2.0',
    id: 91,
    result: { number: '0x1' },
  })
const primary = failed('https://primary.example/secret')
const secondary = failed('https://secondary.example/key')
let tick = 0
const now = () => new Date(`2026-09-30T04:00:0${tick++}.124Z`)

test('two actual distinct-origin header failures yield redacted capture attempt', async () => {
  tick = 0
  const receipt = await probeMorphoMissingCapture({ row, primary, secondary, now })
  assert.equal(receipt.evidenceDoc.kind, 'capture_attempt')
  assert.equal(receipt.evidenceDoc.missingReason, 'rpc_unavailable')
  assert.equal(receipt.evidenceDoc.request.method, 'eth_getBlockByNumber')
  assert.equal(receipt.verifierDoc.finding, 'unavailable')
  assert.equal(receipt.verifierDoc.provider, 'https://secondary.example')
  assert.doesNotMatch(JSON.stringify(receipt), /secret|\/key/)
})

test('a live origin, malformed reply, revert, or late clock cannot mint missing', async () => {
  tick = 0
  assert.equal(
    await probeMorphoMissingCapture({
      row,
      primary: success('https://primary.example'),
      secondary,
      now,
    }),
    null,
  )
  tick = 0
  assert.equal(
    await probeMorphoMissingCapture({
      row,
      primary,
      secondary: success('https://secondary.example'),
      now,
    }),
    null,
  )
  tick = 0
  assert.equal(
    await probeMorphoMissingCapture({
      row,
      primary: client('https://primary.example', { jsonrpc: '2.0', id: 12 }),
      secondary,
      now,
    }),
    null,
  )
  tick = 0
  assert.equal(
    await probeMorphoMissingCapture({
      row,
      primary: client('https://primary.example', {
        jsonrpc: '2.0',
        id: 91,
        error: { code: 3, message: 'execution reverted' },
      }),
      secondary,
      now,
    }),
    null,
  )
  assert.equal(
    await probeMorphoMissingCapture({
      row,
      primary,
      secondary,
      now: () => new Date('2026-09-30T06:01:00.000Z'),
    }),
    null,
  )
  await assert.rejects(
    () =>
      probeMorphoMissingCapture({
        row,
        primary,
        secondary: failed('https://primary.example/another-path'),
        now,
      }),
    /missing_origins_not_independent/,
  )
})

test('transport errors are classified without persisting exception URLs', async () => {
  tick = 0
  const broken = (url) => ({
    url,
    provider: new URL(url).origin,
    send: async () => {
      throw Error('rpc_http_503')
    },
  })
  const receipt = await probeMorphoMissingCapture({
    row,
    primary: broken('https://primary.example/token'),
    secondary: broken('https://secondary.example/token'),
    now,
  })
  assert.equal(receipt.evidenceDoc.response.kind, 'transport_error')
  assert.equal(receipt.evidenceDoc.error.code, 'rpc_http_503')
  assert.doesNotMatch(JSON.stringify(receipt), /\/token/)
  const programmingError = {
    ...broken('https://primary.example/token'),
    send: async () => {
      throw Error('bad local serializer')
    },
  }
  tick = 0
  assert.equal(
    await probeMorphoMissingCapture({
      row,
      primary: programmingError,
      secondary: broken('https://secondary.example/token'),
      now,
    }),
    null,
  )
})

test('both failed probes finish inside the target window', async () => {
  let calls = 0
  await assert.rejects(
    () =>
      probeMorphoMissingCapture({
        row,
        primary,
        secondary,
        now: () => new Date(calls++ < 2 ? '2026-09-30T05:59:59.000Z' : '2026-09-30T06:00:01.000Z'),
      }),
    /missing_evidence_invalid/,
  )
})

test('SQL binds verifier hash to PostgreSQL JSONB evidence digest', async () => {
  tick = 0
  const receipt = await probeMorphoMissingCapture({ row, primary, secondary, now })
  let query = ''
  let params = []
  const id = await writeMorphoMissingReceipt((strings, ...args) => {
    query = strings.join('?')
    params = args
    return [{ id: '51' }]
  }, receipt)
  assert.equal(id, '51')
  assert.match(query, /jsonb_set\(/)
  assert.match(query, /sha256\(convert_to\(verifier_doc::text/)
  assert.equal(JSON.parse(params[0]).schema, 'carry_exit_v2_missing_v1')
  assert.equal(JSON.parse(params[1]).evidenceSha256, null)
})

test('readback accepts only matching verified capture receipt shape', async () => {
  const accepted = await readMorphoMissingReceipt(
    () => [
      {
        id: '51',
        missingReason: 'rpc_unavailable',
        evidenceKind: 'capture_attempt',
        verifierKind: 'rpc_replay',
        captureProvider: 'https://primary.example',
        verifierProvider: 'https://secondary.example',
      },
    ],
    '42',
    4,
  )
  assert.equal(accepted.id, '51')
  await assert.rejects(
    () =>
      readMorphoMissingReceipt(
        () => [{ ...accepted, verifierProvider: accepted.captureProvider }],
        '42',
        4,
      ),
    /missing_receipt_untrusted/,
  )
})
