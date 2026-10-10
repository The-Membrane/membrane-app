import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { buildSeed } from './make-seed.mjs'
import { collectSnapshot, normalizeSeed } from './collector.mjs'
import { checkpointForRun, filterSeed } from './run.mjs'

const OWNER_A = '0x0000000000000000000000000000000000000001'
const OWNER_B = '0x0000000000000000000000000000000000000002'
const VAULT = '0x0000000000000000000000000000000000000003'
const ASSET = '0x0000000000000000000000000000000000000004'
const HASH = `0x${'a'.repeat(64)}`

const seed = {
  schemaVersion: 1,
  cohortId: 'test-cohort',
  positions: [
    { owner: OWNER_A, vault: VAULT, routeIds: ['GHO → sGHO'] },
    { owner: OWNER_B, vault: VAULT, routeIds: ['GHO → sGHO'] },
  ],
}

function mockClient({ failB = false, chainId = 1 } = {}) {
  const calls = []
  const client = {
    calls,
    async getChainId() {
      calls.push({ operation: 'getChainId' })
      return chainId
    },
    async getBlock(args) {
      calls.push({ operation: 'getBlock', ...args })
      return { number: 123n, timestamp: 1_700_000_000n, hash: HASH }
    },
    async readContract(args) {
      calls.push(args)
      assert.equal(args.blockNumber, 123n)
      if (args.functionName === 'balanceOf') {
        if (args.args[0] === OWNER_B && failB) throw new Error('RPC unavailable')
        return args.args[0] === OWNER_A ? 500n : 0n
      }
      if (args.functionName === 'asset') return ASSET
      if (args.functionName === 'decimals') return 6
      if (args.functionName === 'convertToAssets') return args.args[0] * 2n
      throw new Error(`Unexpected read: ${args.functionName}`)
    },
  }
  return client
}

test('offline seed keeps exact owner+vault and all route labels, with source hash', () => {
  const raw = JSON.stringify([
    { borrower: OWNER_A, dest: VAULT, destKind: 'vault', route: 'GHO → sGHO' },
    { borrower: OWNER_A, dest: VAULT, destKind: 'vault', route: 'GHO → other' },
    { borrower: OWNER_B, dest: 'Aave V3', destKind: 'lend', route: 'GHO → supply' },
  ])
  const sourceHash = createHash('sha256').update(raw).digest('hex')
  const result = buildSeed(raw, 'routes_ab.json', sourceHash, 'test-cohort')
  assert.equal(result.unsupported, 1)
  assert.deepEqual(result.seed.positions, [
    { owner: OWNER_A, vault: VAULT, routeIds: ['GHO → other', 'GHO → sGHO'] },
  ])
  assert.equal(result.seed.source.sha256, sourceHash)
  assert.match(normalizeSeed(result.seed).seedHash, /^[a-f0-9]{64}$/)
})

test('rejects duplicate owner+vault and unbounded seeds', () => {
  assert.throws(
    () => normalizeSeed({ ...seed, positions: [seed.positions[0], seed.positions[0]] }),
    /Duplicate/,
  )
  assert.throws(() => normalizeSeed(seed, 1), /1–1 positions/)
})

test('one finalized block, asset metadata memoized, and genuine zero retained', async () => {
  const client = mockClient()
  const saved = []
  const result = await collectSnapshot(client, seed, {
    onProgress: (snapshot) => saved.push(JSON.parse(JSON.stringify(snapshot))),
  })
  assert.equal(client.calls.filter((call) => call.operation === 'getBlock').length, 1)
  assert.equal(client.calls.filter((call) => call.functionName === 'asset').length, 1)
  assert.equal(client.calls.filter((call) => call.functionName === 'decimals').length, 1)
  assert.equal(result.blockNumber, '123')
  assert.equal(result.positions[0].assetBalance, '0.001')
  assert.equal(result.positions[1].assetBalance, '0')
  assert.equal(result.positions[1].status, 'ok')
  assert.equal(result.complete, true)
  assert.ok(saved.length >= 4)
})

test('failed holder read remains unknown and retries at saved block without re-reading successful row', async () => {
  const firstClient = mockClient({ failB: true })
  const first = await collectSnapshot(firstClient, seed)
  assert.equal(first.complete, false)
  assert.equal(first.positions[1].status, 'unknown')
  assert.equal(first.positions[1].assetBalance, null)
  assert.deepEqual(first.positions[1].errors, ['balance_read_failed'])

  const nextClient = mockClient()
  const next = await collectSnapshot(nextClient, seed, { snapshot: first })
  assert.equal(nextClient.calls.filter((call) => call.operation === 'getBlock').length, 0)
  assert.equal(nextClient.calls.filter((call) => call.functionName === 'balanceOf').length, 1)
  assert.equal(next.blockNumber, '123')
  assert.equal(next.complete, true)
})

test('does not resume a checkpoint from another seed', async () => {
  const first = await collectSnapshot(mockClient(), seed)
  const altered = {
    ...seed,
    positions: [{ ...seed.positions[0], routeIds: ['different route'] }, seed.positions[1]],
  }
  await assert.rejects(
    collectSnapshot(mockClient(), altered, { snapshot: first }),
    /does not match/,
  )
})

test('rejects non-mainnet RPC before finalized block or holder reads', async () => {
  const client = mockClient({ chainId: 10 })
  await assert.rejects(collectSnapshot(client, seed), /Ethereum mainnet RPC required/)
  assert.deepEqual(
    client.calls.map((call) => call.operation),
    ['getChainId'],
  )
})

test('exact route pilot preserves source and all identities but changes seed hash', () => {
  const source = { name: 'routes_ab.json', sha256: 'f'.repeat(64) }
  const full = {
    ...seed,
    source,
    positions: [
      { ...seed.positions[0], routeIds: ['GHO → sGHO', 'GHO → other'] },
      { ...seed.positions[1], routeIds: ['GHO → other'] },
    ],
  }
  const pilot = filterSeed(full, 'GHO → sGHO')
  assert.equal(pilot.positions.length, 1)
  assert.deepEqual(pilot.positions[0].routeIds, ['GHO → sGHO', 'GHO → other'])
  assert.deepEqual(pilot.source, source)
  assert.notEqual(normalizeSeed(pilot).seedHash, normalizeSeed(full).seedHash)
})

test('new hourly tick gets a new finalized block, while a recent interruption resumes', () => {
  const now = Date.parse('2026-09-26T18:00:00.000Z')
  const recent = { complete: false, startedAt: '2026-09-26T17:30:00.000Z' }
  assert.equal(checkpointForRun(recent, now), recent)
  assert.equal(checkpointForRun({ ...recent, complete: true }, now), undefined)
  assert.equal(
    checkpointForRun({ ...recent, startedAt: '2026-09-26T16:30:00.000Z' }, now),
    undefined,
  )
})

test('checked-in seed distinguishes exact GHO→sGho from USDe→sGho', () => {
  const checkedIn = JSON.parse(
    readFileSync(new URL('./aug-2026-ab-vault-seed.json', import.meta.url), 'utf8'),
  )
  assert.equal(filterSeed(checkedIn, 'GHO → sGho [GHO]').positions.length, 20)
  assert.equal(filterSeed(checkedIn, 'USDe → sGho [GHO]').positions.length, 1)
})
