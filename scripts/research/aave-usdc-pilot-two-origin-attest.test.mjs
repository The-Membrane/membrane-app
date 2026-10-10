import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ATTESTATION_ORIGINS,
  attestationFiles,
  documentFor,
  readSealedJson,
  verifyOne,
} from './aave-usdc-pilot-two-origin-attest.mjs'

const H = (digit) => `0x${digit.repeat(64)}`
const A = (digit) => `0x${digit.repeat(40)}`
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const source = {
  sha256: '1'.repeat(64),
  pool: A('1'),
  underlying: A('2'),
  aToken: A('3'),
  from: { blockNumber: 100, blockHash: H('a'), cashRaw: '100' },
  to: { blockNumber: 101, blockHash: H('b'), cashRaw: '90' },
  chunks: {
    poolOperations: [{ fromBlock: 101, toBlock: 101, queries: [{ logs: [] }] }],
    underlyingTransfers: [
      {
        fromBlock: 101,
        toBlock: 101,
        queries: [{ logs: [] }, { logs: [] }],
      },
    ],
  },
}
const specs = [
  { kind: 'cashIn', fromBlock: 101, toBlock: 101, expected: [] },
  { kind: 'cashOut', fromBlock: 101, toBlock: 101, expected: [] },
  { kind: 'pool', fromBlock: 101, toBlock: 101, expected: [] },
]
const endpoints = [
  { number: 100, hash: H('a'), cashRaw: '100' },
  { number: 101, hash: H('b'), cashRaw: '90' },
]
const observation = { endpoints, logs: [[], [], []] }
const origins = ATTESTATION_ORIGINS.map((origin) => ({ origin }))

test('independent attestation binds all three raw queries and endpoint balances', () => {
  const doc = documentFor(source, 0, origins, [observation, structuredClone(observation)], specs)
  assert.equal(verifyOne(doc, source, 0).sha256, doc.sha256)
  const omitted = structuredClone(doc)
  omitted.observations[0].queries.pop()
  const { sha256: _old, ...body } = omitted
  omitted.sha256 = hash(body)
  assert.throws(() => verifyOne(omitted, source, 0), /attestation_origin_disagreement/)
  const cash = structuredClone(doc)
  cash.observations[0].endpoints[1].cashRaw = '91'
  cash.observations[1].endpoints[1].cashRaw = '91'
  const { sha256: _prior, ...changed } = cash
  cash.sha256 = hash(changed)
  assert.throws(() => verifyOne(cash, source, 0), /attestation_endpoint_mismatch/)
  const differentOrigin = structuredClone(doc)
  differentOrigin.observations[1].queries[0].logs.push({ blockHash: H('c') })
  const { sha256: _third, ...different } = differentOrigin
  differentOrigin.sha256 = hash(different)
  assert.throws(() => verifyOne(differentOrigin, source, 0), /attestation_origin_disagreement/)
  const forgedOrigins = structuredClone(doc)
  forgedOrigins.originFingerprints = [hash('https://other.test'), hash('https://other2.test')]
  const { sha256: _fourth, ...forged } = forgedOrigins
  forgedOrigins.sha256 = hash(forged)
  assert.throws(() => verifyOne(forgedOrigins, source, 0), /invalid_attestation_document/)
})

test('conflicting public origins cannot seal a source-matching attestation', () => {
  const other = structuredClone(observation)
  other.logs[0] = [{ blockHash: H('c') }]
  assert.throws(
    () => documentFor(source, 0, origins, [observation, other], specs),
    /attestation_origin_disagreement/,
  )
  assert.throws(
    () =>
      documentFor(
        source,
        0,
        [{ origin: 'https://other.test' }, origins[1]],
        [observation, observation],
        specs,
      ),
    /wrong_attestation_origins/,
  )
})

test('bounded sealed-file reader refuses symlinks and oversized regular files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aave-usdc-attest-'))
  try {
    const good = join(dir, 'good.json')
    const link = join(dir, 'link.json')
    const large = join(dir, 'large.json')
    writeFileSync(good, '{"ok":true}\n')
    symlinkSync(good, link)
    writeFileSync(large, `{"long":"${'x'.repeat(256)}"}`)
    assert.deepEqual(readSealedJson(good, 32), { ok: true })
    assert.throws(() => readSealedJson(link, 32), /invalid_attestation_file/)
    assert.throws(() => readSealedJson(large, 32), /invalid_attestation_file/)
    assert.throws(() => readSealedJson(dir, 32), /invalid_attestation_file/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('attestation directory accepts only canonical regular allowlisted entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'aave-usdc-dir-'))
  try {
    const actual = join(root, 'actual')
    mkdirSync(actual)
    const canonical = realpathSync(actual)
    writeFileSync(join(canonical, 'receipt-00.json'), '{}\n')
    assert.deepEqual(attestationFiles(1, canonical), ['receipt-00.json'])
    writeFileSync(join(canonical, 'other.json'), '{}\n')
    assert.throws(() => attestationFiles(1, canonical), /unexpected_attestation_file/)
    rmSync(join(canonical, 'other.json'))
    symlinkSync(join(canonical, 'receipt-00.json'), join(canonical, 'receipt-01.json'))
    assert.throws(() => attestationFiles(2, canonical), /invalid_attestation_file/)
    rmSync(join(canonical, 'receipt-01.json'))
    const alias = join(root, 'alias')
    symlinkSync(canonical, alias)
    assert.throws(() => attestationFiles(1, alias), /invalid_attestation_directory/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
