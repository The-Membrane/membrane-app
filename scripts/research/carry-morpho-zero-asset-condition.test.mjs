import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BOARD_ROUTES } from './carry-local-morpho-holder-v2.mjs'
import {
  capture,
  parseCli,
  readVerifiedMorphoZeroAssetConditions,
  save,
  selectRpcUrls,
  validateRecord,
  verify,
} from './carry-morpho-zero-asset-condition.mjs'

const hash = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`
const word = (n) => hash(n)
const route = BOARD_ROUTES[3]
const block = 100
const mkClient = (host, { assets = 0n, supply = 3n, changed = false } = {}) => {
  let headerReads = 0
  return {
    url: `https://${host}/rpc`,
    async request(method, params) {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') {
        if (params[0] === 'finalized') return { number: '0x65' }
        headerReads++
        return {
          number: '0x64',
          hash: hash(changed && headerReads > 1 ? 101 : 100),
          parentHash: hash(99),
          timestamp: '0x3e8',
        }
      }
      if (method === 'eth_getCode') return '0x6000'
      if (method === 'eth_call') {
        assert.deepEqual(params[1], { blockHash: hash(100), requireCanonical: true })
        if (params[0].data === '0x38d52e0f') return `0x${'0'.repeat(24)}${route.asset.slice(2)}`
        if (params[0].data === '0x01e1d114') return word(assets)
        if (params[0].data === '0x18160ddd') return word(supply)
      }
      throw Error(`unexpected ${method}`)
    },
  }
}

const captureOne = (b = mkClient('b.example')) =>
  capture({
    routeIndices: [3],
    blocks: [block],
    clients: [mkClient('a.example'), b],
    now: () => new Date('2026-10-02T00:00:00.000Z'),
  })

test('explicit two-host pinned sample seals zero assets with positive shares', async () => {
  const [record] = await captureOne()
  assert.equal(record.status, 'zero_assets_positive_shares')
  assert.equal(record.witnesses[0].totalAssetsRaw, '0')
  assert.equal(record.witnesses[0].totalSupplyRaw, '3')
  assert.equal(validateRecord(record), record)
  await assert.rejects(captureOne(mkClient('b.example', { assets: 1n })), /host_disagreement/)
  await assert.rejects(captureOne(mkClient('b.example', { changed: true })), /condition_reorg/)
})

test('immutable private record verifies offline and rejects tampering, unknown files, duplicates', async () => {
  const out = await mkdtemp(join(tmpdir(), 'morpho-condition-'))
  const stat = () => ({ bavail: 2_000_000, bsize: 1024 })
  try {
    const records = await captureOne()
    const [path] = await save({ records, out, stat })
    assert.deepEqual(await verify({ out }), { count: 1, zeroAssetsPositiveShares: 1 })
    const [row] = await readVerifiedMorphoZeroAssetConditions({ out })
    assert.equal(row.routeIndex, 3)
    assert.equal(row.allObservedZeroAssetsPositiveShares, true)
    assert.deepEqual(
      row.observations.map((item) => item.block),
      [100],
    )
    await assert.rejects(save({ records, out, stat }), /condition_already_recorded/)
    await writeFile(join(out, 'unexpected.txt'), 'x')
    await assert.rejects(verify({ out }), /condition_unknown_file/)
    await rm(join(out, 'unexpected.txt'))
    const original = await readFile(path, 'utf8')
    await writeFile(path, original.replace('zero_assets_positive_shares', 'nonzero_assets'))
    await assert.rejects(verify({ out }), /condition_seal_invalid/)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('duplicate later in a batch cannot publish an earlier record', async () => {
  const out = await mkdtemp(join(tmpdir(), 'morpho-condition-'))
  const stat = () => ({ bavail: 2_000_000, bsize: 1024 })
  try {
    const [record] = await captureOne()
    await assert.rejects(save({ records: [record, record], out, stat }), /condition_duplicate/)
    assert.deepEqual(await readdir(out), [])
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('CLI enforces explicit bounded unique route and block selections', () => {
  assert.deepEqual(parseCli(['--capture', '--routes', '3,8', '--blocks', '100,101']), {
    mode: 'capture',
    routeIndices: [3, 8],
    blocks: [100, 101],
  })
  assert.throws(
    () => parseCli(['--capture', '--routes', '3,3', '--blocks', '100']),
    /selection_invalid/,
  )
  assert.throws(
    () => parseCli(['--capture', '--routes', '3', '--blocks', '100,100']),
    /selection_invalid/,
  )
  assert.throws(
    () => parseCli(['--capture', '--routes', '3', '--blocks', '-1']),
    /selection_invalid/,
  )
  assert.throws(
    () =>
      parseCli([
        '--capture',
        '--routes',
        '3',
        '--blocks',
        Array.from({ length: 17 }, (_, i) => i + 1).join(','),
      ]),
    /selection_invalid/,
  )
})

test('configured host selection chooses two independent RPC origins', () => {
  const urls = ['https://a.example/key', 'https://b.example/key', 'https://c.example/key']
  assert.deepEqual(selectRpcUrls(urls, 'a.example,c.example'), [urls[0], urls[2]])
  assert.throws(() => selectRpcUrls(urls, 'a.example,a.example'), /two_hosts_required/)
  assert.throws(() => selectRpcUrls(urls, 'a.example,d.example'), /origin_not_configured/)
})

test('disk reserve prevents publication', async () => {
  const out = await mkdtemp(join(tmpdir(), 'morpho-condition-'))
  try {
    await assert.rejects(
      save({ records: await captureOne(), out, stat: () => ({ bavail: 1, bsize: 1024 }) }),
      /condition_disk_reserve/,
    )
    assert.deepEqual(await readdir(out), [])
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})
