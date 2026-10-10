import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { FACTORY_SHA, MANIFEST_SHA, selectAnchors } from './morpho-v2-full-cohort-baseline.mjs'
import {
  continueBaseline,
  FACTORY_PATH,
  MANIFEST_PATH,
  OUTPUT_PATH,
  RAW_DIR,
  readPinned,
  SEED_PATH,
  SEED_ROWS,
  SEED_SHA,
  verifyContinuation,
  verifySeed,
} from './morpho-v2-full-cohort-baseline-continuation.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fixture = () => {
  const anchors = selectAnchors(
    readPinned(MANIFEST_PATH, MANIFEST_SHA),
    readPinned(FACTORY_PATH, FACTORY_SHA),
  )
  const seed = verifySeed(readPinned(SEED_PATH, SEED_SHA), anchors)
  return { anchors, seed }
}
const reseal = ({ checkpointSha256, ...rest }) => ({
  ...rest,
  checkpointSha256: sha(JSON.stringify(rest)),
})

test('immutable first64 source, order, and raw prefix links verify offline', () => {
  const { anchors, seed } = fixture()
  assert.equal(seed.results.length, SEED_ROWS)
  assert.equal(anchors.length, 304)
  assert.equal(seed.results[63].proposalIndex, anchors[63].proposalIndex)
  assert.equal(sha(readFileSync(SEED_PATH)), SEED_SHA)
})

test('physical source tamper, reordered frontier, and mixed seed prefix fail closed', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'morpho-continuation-source-'))
  try {
    const changed = resolve(dir, 'seed.json')
    const bytes = readFileSync(SEED_PATH)
    writeFileSync(changed, Buffer.concat([bytes, Buffer.from(' ')]))
    assert.throws(() => readPinned(changed, SEED_SHA), /physical SHA/)
    const { anchors, seed } = fixture()
    const reordered = structuredClone(seed)
    ;[reordered.results[62], reordered.results[63]] = [reordered.results[63], reordered.results[62]]
    assert.throws(() => verifySeed(reseal(reordered), anchors), /frontier/)
    const mixed = structuredClone(seed)
    mixed.results[0].status = 'withdraw-rpc-ambiguous'
    assert.throws(() => verifyContinuation(reseal(mixed), seed, anchors), /prefix/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dry mode neither contacts RPC nor writes a continuation', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'morpho-continuation-dry-'))
  try {
    const out = resolve(dir, 'new.json')
    const client = { request: () => assert.fail('dry contacted RPC') }
    const result = await continueBaseline({ mode: 'dry', out, client, maxAnchors: 304 })
    assert.deepEqual(result, { mode: 'dry', completed: 64, next: 304 })
    assert.throws(() => readFileSync(out), /ENOENT/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run seeds a distinct versioned checkpoint and resumes at row64', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'morpho-continuation-boundary-'))
  try {
    const out = resolve(dir, 'continued.json')
    const { anchors, seed } = fixture()
    const client = { request: () => assert.fail('mock collector contacted RPC') }
    const collect = async (args) => {
      assert.equal(args.out, out)
      assert.equal(args.rawDir, RAW_DIR)
      assert.equal(args.maxAnchors, 65)
      assert.equal(args.client, client)
      assert.equal(sha(readFileSync(out)), SEED_SHA)
      const row = anchors[64]
      const resumed = reseal({
        ...seed,
        results: [
          ...seed.results,
          {
            index: row.index,
            proposalIndex: row.proposalIndex,
            vault: row.vault,
            anchorBlock: row.anchorBlock,
            preBlock: row.preBlock,
            preBlockHash: `0x${'a'.repeat(64)}`,
            status: 'zero-baseline-size',
          },
        ],
      })
      writeFileSync(out, JSON.stringify(resumed))
      return resumed
    }
    const result = await continueBaseline({
      mode: 'run',
      out,
      maxAnchors: 65,
      client,
      collect,
      diskGuard: () => {},
    })
    assert.equal(result.completed, 65)
    assert.equal(sha(readFileSync(SEED_PATH)), SEED_SHA)
    const sidecar = JSON.parse(readFileSync(`${out}.lineage-v2.json`, 'utf8'))
    assert.equal(sidecar.seedPhysicalSha256, SEED_SHA)
    assert.equal(sidecar.version, 2)
    assert.equal(sidecar.rawDir, RAW_DIR)
    assert.equal((await continueBaseline({ mode: 'verify', out })).completed, 65)
    assert.throws(
      () => verifyContinuation(reseal({ ...result.checkpoint, results: [] }), seed, anchors),
      /shorter than seed/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('real collector accepts the seeded 64-row frontier without an RPC read', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'morpho-continuation-real-frontier-'))
  try {
    const out = resolve(dir, 'continued.json')
    const client = { request: () => assert.fail('completed frontier contacted RPC') }
    const result = await continueBaseline({
      mode: 'run',
      out,
      maxAnchors: 64,
      client,
      diskGuard: () => {},
    })
    assert.equal(result.completed, 64)
    assert.equal(sha(readFileSync(out)), SEED_SHA)
    assert.equal((await continueBaseline({ mode: 'verify', out })).completed, 64)
    assert.equal(sha(readFileSync(SEED_PATH)), SEED_SHA)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('existing mixed lineage and pinned source output cannot be overwritten', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'morpho-continuation-mixed-'))
  try {
    const out = resolve(dir, 'continued.json')
    const client = { request: () => assert.fail('unexpected RPC') }
    await assert.rejects(
      continueBaseline({ mode: 'run', out: SEED_PATH, client, diskGuard: () => {} }),
      /may not overwrite/,
    )
    writeFileSync(out, readFileSync(SEED_PATH))
    const fakeLineage = { study: 'other-source', lineageSha256: '0'.repeat(64) }
    writeFileSync(`${out}.lineage-v2.json`, JSON.stringify(fakeLineage))
    await assert.rejects(
      continueBaseline({ mode: 'run', out, client, diskGuard: () => {} }),
      /lineage seal mismatch/,
    )
    assert.equal(sha(readFileSync(out)), SEED_SHA)
    assert.notEqual(out, OUTPUT_PATH)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
