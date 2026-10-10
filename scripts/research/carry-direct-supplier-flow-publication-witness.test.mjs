import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  directSupplierFlowPublicationWitnessPath,
  readDirectSupplierFlowPublicationWitness,
  writeDirectSupplierFlowPublicationWitness,
} from './carry-direct-supplier-flow-publication-witness.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const captureCompletedAt = '2026-10-04T12:00:00.000Z'
const receivedAt = Date.parse('2026-10-04T12:00:01.000Z')

function sealed(study = 'carry-direct-supplier-flow-receipts-v2') {
  const body = {
    study,
    marketKey: 'aaveV3Usdc',
    range: { fromBlock: 100, toBlock: 100 },
    captureStartedAt: '2026-10-04T11:59:59.000Z',
    captureCompletedAt,
  }
  return { ...body, sha256: hash(JSON.stringify(body)) }
}

function published(directory, document = sealed()) {
  const path = join(directory, 'aaveV3Usdc-100-100.json')
  writeFileSync(path, `${JSON.stringify(document)}\n`, { flag: 'wx', mode: 0o444 })
  return path
}

test('post-publication receipt is immutable, bound to exact segment, and ignored by segment readers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'direct-publication-'))
  try {
    const document = sealed()
    const path = published(directory, document)
    assert.equal(readDirectSupplierFlowPublicationWitness(path, document).firstLocalReceiptAt, null)
    const result = writeDirectSupplierFlowPublicationWitness(path, document, {
      now: () => receivedAt,
    })
    assert.equal(result.status, 'local_publication_witness')
    assert.equal(result.firstLocalReceiptAt, '2026-10-04T12:00:01.000Z')
    assert.equal(result.clockBasis, 'local_operator_clock_unwitnessed')
    assert.equal(result.prospectiveValidation, false)
    const witnessPath = directSupplierFlowPublicationWitnessPath(path)
    assert.deepEqual(readdirSync(directory).sort(), [
      '.direct-flow-publication-aaveV3Usdc-100-100.json',
      'aaveV3Usdc-100-100.json',
    ])
    assert.equal(readFileSync(witnessPath, 'utf8').includes(document.sha256), true)
    assert.throws(
      () =>
        writeDirectSupplierFlowPublicationWitness(path, document, { now: () => receivedAt + 1 }),
      (error) => error?.code === 'EEXIST',
    )
    assert.equal(
      readDirectSupplierFlowPublicationWitness(path, document).firstLocalReceiptAt,
      result.firstLocalReceiptAt,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('interrupted publication leaves no inferred receipt and resumed legacy stays unknown', () => {
  const directory = mkdtempSync(join(tmpdir(), 'direct-publication-crash-'))
  try {
    const document = sealed()
    const path = published(directory, document)
    writeFileSync(join(directory, '.direct-flow-publication-stage-interrupted.tmp'), '{"partial":')
    assert.deepEqual(readDirectSupplierFlowPublicationWitness(path, document), {
      status: 'unavailable',
      reason: 'post_publication_witness_missing',
      firstLocalReceiptAt: null,
      clockBasis: 'local_operator_clock_unwitnessed',
      prospectiveValidation: false,
    })
    assert.throws(
      () =>
        writeDirectSupplierFlowPublicationWitness(path, document, {
          now: () => receivedAt - 2_000,
        }),
      /direct_publication_clock_invalid/,
    )
    assert.equal(readDirectSupplierFlowPublicationWitness(path, document).firstLocalReceiptAt, null)

    const legacy = { study: 'carry-direct-supplier-flow-receipts-v1' }
    assert.equal(readDirectSupplierFlowPublicationWitness(path, legacy).status, 'unknown')
    assert.equal(writeDirectSupplierFlowPublicationWitness(path, legacy).status, 'unknown')
    assert.equal(
      readdirSync(directory).some((name) => name.startsWith('.direct-flow-publication-aave')),
      false,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('read verifier rejects a tampered witness, renamed segment, or changed segment bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'direct-publication-tamper-'))
  try {
    const document = sealed()
    const path = published(directory, document)
    writeDirectSupplierFlowPublicationWitness(path, document, { now: () => receivedAt })
    const witnessPath = directSupplierFlowPublicationWitnessPath(path)
    const original = readFileSync(witnessPath, 'utf8')
    const changed = JSON.parse(original)
    changed.firstLocalReceiptAt = '2026-10-04T12:00:00.000Z'
    chmodSync(witnessPath, 0o600)
    writeFileSync(witnessPath, `${JSON.stringify(changed)}\n`)
    assert.throws(
      () => readDirectSupplierFlowPublicationWitness(path, document),
      /direct_publication_witness_digest_mismatch/,
    )
    writeFileSync(witnessPath, original)
    const differentPath = join(directory, 'aaveV3Usdc-100-101.json')
    writeFileSync(differentPath, `${JSON.stringify(document)}\n`)
    copyFileSync(witnessPath, directSupplierFlowPublicationWitnessPath(differentPath))
    assert.throws(
      () => readDirectSupplierFlowPublicationWitness(differentPath, document),
      /direct_segment_filename_mismatch/,
    )
    chmodSync(path, 0o600)
    writeFileSync(path, `${JSON.stringify(document)}\n `)
    assert.throws(
      () => readDirectSupplierFlowPublicationWitness(path, document),
      /direct_segment_file_mismatch/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('valid v2 body cannot be witnessed under a different market, range, or flow kind filename', () => {
  const directory = mkdtempSync(join(tmpdir(), 'direct-publication-identity-'))
  try {
    const document = sealed()
    for (const name of [
      'aaveV3Usde-100-100.json',
      'aaveV3Usdc-100-101.json',
      'supply-aaveV3Usdc-100-100.json',
    ]) {
      const path = join(directory, name)
      writeFileSync(path, `${JSON.stringify(document)}\n`)
      assert.throws(
        () => readDirectSupplierFlowPublicationWitness(path, document),
        /direct_segment_filename_mismatch/,
      )
      assert.throws(
        () => writeDirectSupplierFlowPublicationWitness(path, document, { now: () => receivedAt }),
        /direct_segment_filename_mismatch/,
      )
      assert.equal(existsSync(directSupplierFlowPublicationWitnessPath(path)), false)
    }
    const supply = sealed('carry-direct-supplier-supply-flow-receipts-v2')
    const supplyPath = join(directory, 'supply-aaveV3Usdc-100-100.json')
    rmSync(supplyPath)
    writeFileSync(supplyPath, `${JSON.stringify(supply)}\n`)
    assert.equal(
      writeDirectSupplierFlowPublicationWitness(supplyPath, supply, { now: () => receivedAt })
        .status,
      'local_publication_witness',
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
