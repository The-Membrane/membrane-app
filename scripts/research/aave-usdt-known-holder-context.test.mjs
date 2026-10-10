import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import {
  ATOKEN,
  EXPECTED_SOURCE_SHA256,
  HOLDER,
  INDICES,
  OUTPUT_ROOT,
  collect,
  loadGrid,
  outputPath,
  plan,
  saveSnapshot,
} from './aave-usdt-known-holder-context.mjs'
import { validateCheckpoint } from './aave-stable-expansion.mjs'

const grid = loadGrid()
const rawResult = `0x${(500_000_000n * 1_000_000n).toString(16).padStart(64, '0')}`
const sha = (value) => createHash('sha256').update(value).digest('hex')

function fixture({ changedHash = false, wrongTimestamp = false, wrongChain = false } = {}) {
  const calls = []
  const byBlock = new Map(grid.rows.map((row) => [row.block, row]))
  const client = {
    async getChainId() {
      calls.push('chain')
      return wrongChain ? 10 : 1
    },
    async getBlock({ blockNumber }) {
      calls.push('block')
      const row = byBlock.get(Number(blockNumber))
      assert.ok(row)
      return {
        number: blockNumber,
        hash: changedHash ? `0x${'0'.repeat(64)}` : row.blockHash,
        timestamp: BigInt(row.at + Number(wrongTimestamp)),
      }
    },
    async request({ method, params }) {
      calls.push(method)
      assert.equal(method, 'eth_call')
      assert.equal(params[0].to, ATOKEN)
      assert.match(params[0].data, /^0x70a08231/i)
      assert.equal(params[1].requireCanonical, true)
      assert.ok(grid.rows.some((row) => row.blockHash === params[1].blockHash))
      return rawResult
    },
  }
  return { client, calls }
}

test('fixed dry plan uses exactly 15 backwards near-history anchors with one tail censor', () => {
  const p = plan({ grid })
  assert.equal(p.mode, 'dry')
  assert.equal(p.networkReads, 0)
  assert.deepEqual(p.anchorIndices, INDICES)
  assert.equal(p.anchors.length, 15)
  assert.equal(p.anchors[0].nextCashIndex, null)
  assert.equal(p.anchors[1].nextCashIndex, 1568)
  assert.equal(p.anchors.at(-1).index, 1512)
  assert.equal(
    p.sourceFileSha256,
    sha(readFileSync('data/research/venue-signals/aave-stable-expansion-v2.json')),
  )
  assert.equal(p.sourceFileSha256, EXPECTED_SOURCE_SHA256)
})

test('rejects changed archive despite a valid recomputed internal entry seal', () => {
  const changed = JSON.parse(
    readFileSync('data/research/venue-signals/aave-stable-expansion-v2.json', 'utf8'),
  )
  const row = changed.entries.find((entry) => entry.market === 'USDT' && entry.block === 26052206)
  row.cashUsdAssumingPeg += 1
  changed.entriesSha256 = sha(JSON.stringify(changed.entries))
  assert.doesNotThrow(() => validateCheckpoint(changed))
  assert.throws(
    () => loadGrid(undefined, () => Buffer.from(JSON.stringify(changed))),
    /Frozen archive physical SHA mismatch/,
  )
})

test('output path must be explicit and local to ignored research directory', () => {
  assert.throws(() => outputPath(null), /Explicit --out/)
  assert.throws(() => outputPath('/tmp/context.json'), /under data\/research/)
  assert.throws(() => outputPath('../escape.json'), /under data\/research/)
})

test('mocked capture pins hashes, guards every RPC, seals 15 ratios and censors only tail', async () => {
  const out = join(OUTPUT_ROOT, 'known-holder-unit-unused.json')
  const { client, calls } = fixture()
  let guards = 0
  let saved
  const result = await collect({
    client,
    out,
    grid,
    checkDisk: () => guards++,
    now: () => 12345,
    save: (path, value) => {
      assert.equal(path, out)
      saved = value
    },
  })
  assert.equal(calls.length, 31)
  assert.ok(guards >= calls.length + 1)
  assert.equal(result.payload.rows.length, 15)
  assert.equal(result.payload.captureStatus, 'complete')
  assert.equal(result.payload.rowsExpected, 15)
  assert.equal(result.payload.rowsCaptured, 15)
  assert.equal(result.payload.missingCount, 0)
  assert.equal(result.payload.rows.filter((row) => row.claimIsZero).length, 0)
  assert.equal(result.payload.holder, HOLDER)
  assert.equal(result.payload.rows[0].nextCashCensor, 'end-of-saved-grid')
  assert.equal(result.payload.rows[1].nextCashProxy.index, 1568)
  assert.equal(
    result.payload.rows[1].nextCashProxy.elapsedSeconds,
    grid.rows[1568].at - grid.rows[1564].at,
  )
  assert.equal(result.payload.rows.filter((row) => row.nextCashProxy === null).length, 1)
  assert.equal(result.payload.rows[0].claimRaw, '500000000000000')
  assert.ok(BigInt(result.payload.rows[0].claimToCashPpm) > 1_000_000n)
  assert.equal(result.sha256, sha(JSON.stringify(result.payload)))
  assert.deepEqual(saved, result)
})

test('fails closed on wrong chain, stale block hash/time, or disk guard before a read', async () => {
  const out = join(OUTPUT_ROOT, 'known-holder-unit-unused.json')
  await assert.rejects(
    collect({ ...fixture({ wrongChain: true }), out, grid, checkDisk: () => {} }),
    /mainnet/,
  )
  await assert.rejects(
    collect({ ...fixture({ changedHash: true }), out, grid, checkDisk: () => {} }),
    /block identity/,
  )
  await assert.rejects(
    collect({ ...fixture({ wrongTimestamp: true }), out, grid, checkDisk: () => {} }),
    /block identity/,
  )
  let attempted = 0
  const { client } = fixture()
  const blockingClient = {
    ...client,
    async getChainId() {
      attempted++
      return 1
    },
  }
  await assert.rejects(
    collect({
      client: blockingClient,
      out,
      grid,
      checkDisk: () => {
        throw new Error('Disk reserve below 1 GiB')
      },
    }),
    /Disk reserve/,
  )
  assert.equal(attempted, 0)
})

function fakeIo({ partialWrite = false, race = false, corruptRead = false } = {}) {
  const files = new Map()
  return {
    files,
    closeSync() {},
    existsSync: (path) => files.has(path),
    mkdirSync() {},
    openSync(path) {
      files.set(path, '')
      return path
    },
    writeFileSync(path, body) {
      files.set(path, partialWrite ? body.slice(0, 10) : body)
      if (partialWrite) throw new Error('simulated full disk')
    },
    linkSync(from, to) {
      if (race) files.set(to, 'other writer')
      if (files.has(to)) throw new Error('EEXIST')
      files.set(to, files.get(from))
    },
    readFileSync(path) {
      return corruptRead ? '{"broken":true}' : files.get(path)
    },
    unlinkSync(path) {
      files.delete(path)
    },
  }
}

test('atomic checkpoint publication leaves no partial final result and never replaces a race winner', () => {
  const out = join(OUTPUT_ROOT, 'known-holder-unit-unused.json')
  const payload = { study: 'fixture' }
  const sealed = { sha256: sha(JSON.stringify(payload)), payload }
  const partial = fakeIo({ partialWrite: true })
  assert.throws(() => saveSnapshot(out, sealed, () => {}, partial), /full disk/)
  assert.equal(partial.files.size, 0)
  const raced = fakeIo({ race: true })
  assert.throws(() => saveSnapshot(out, sealed, () => {}, raced), /EEXIST/)
  assert.equal(raced.files.get(out), 'other writer')
  assert.equal(raced.files.size, 1)
  const corrupt = fakeIo({ corruptRead: true })
  assert.throws(() => saveSnapshot(out, sealed, () => {}, corrupt), /Saved SHA mismatch/)
  assert.equal(corrupt.files.size, 0)
  const good = fakeIo()
  saveSnapshot(out, sealed, () => {}, good)
  assert.equal(good.files.size, 1)
  assert.deepEqual(JSON.parse(good.files.get(out)), sealed)
})

test('CLI failure does not echo an error or a credential-bearing RPC environment value', () => {
  const token = 'credential-secret-should-never-print'
  const result = spawnSync(
    process.execPath,
    ['scripts/research/aave-usdt-known-holder-context.mjs', '--run'],
    {
      cwd: process.cwd(),
      env: { ...process.env, RECORDER_RPC_URL: `https://example.invalid/${token}` },
      encoding: 'utf8',
    },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Holder context capture failed/)
  assert.doesNotMatch(result.stderr, /Explicit --out|credential-secret|example.invalid/)
})
