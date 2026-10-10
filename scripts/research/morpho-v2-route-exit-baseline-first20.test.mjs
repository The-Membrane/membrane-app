import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { resolve } from 'node:path'
import {
  FACTORY_SHA, HEADERS_SHA, selectFirst20, seal, validateRaw,
} from './morpho-v2-route-exit-baseline-first20.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fixture = (path, expected) => {
  const bytes = readFileSync(resolve(path))
  assert.equal(sha(bytes), expected)
  return JSON.parse(bytes)
}

test('frozen complete inputs select first 20 distinct vaults in event coordinates', () => {
  const headers = fixture('data/research/venue-signals/morpho-v2-route-address-headers.json', HEADERS_SHA)
  const factory = fixture(`data/research/venue-signals/${FACTORY_SHA}.json`, FACTORY_SHA)
  const selected = selectFirst20(headers, factory)
  assert.equal(selected.length, 20)
  assert.equal(new Set(selected.map((x) => x.vault)).size, 20)
  assert.equal(selected[0].vault, '0xdcdcea96147672fe3b56dcb1aa5608332b67ff84')
  assert.equal(selected[0].block, 23420016)
  assert.equal(selected.at(-1).block, 24929298)
  for (const row of selected) {
    assert.ok(row.creationBlock < row.block)
    assert.notEqual(row.fromAdapter, row.toAdapter)
    assert.notEqual(row.fromAdapter, '0x0000000000000000000000000000000000000000')
    assert.notEqual(row.toAdapter, '0x0000000000000000000000000000000000000000')
  }
  assert.throws(() => selectFirst20({ ...headers, status: 'partial' }, factory))
  assert.throws(() => selectFirst20(headers, factory, 21))
})

test('raw ledger checkpoint is fail-closed on mutation, frontier, and anchor', () => {
  const anchor = {
    vault: '0x1111111111111111111111111111111111111111',
    block: 12,
    txHash: `0x${'1'.repeat(64)}`,
    creationBlock: 10,
  }
  const raw = seal({ study: 'morpho-v2-route-pre-b-transfer-logs-v1', chainId: 1,
    headersSha256: HEADERS_SHA, factorySha256: FACTORY_SHA,
    vault: anchor.vault, routeBlock: anchor.block, routeTxHash: anchor.txHash,
    fromBlock: 10, throughBlock: 11, chunkBlocks: 8_000,
    nextBlock: 12, logs: [], status: 'complete' })
  assert.equal(validateRaw(raw, anchor), raw)
  assert.throws(() => validateRaw({ ...raw, nextBlock: 11 }, anchor))
  assert.throws(() => validateRaw({ ...raw, logs: [{ block: 10 }] }, anchor))
  assert.throws(() => validateRaw(raw, { ...anchor, block: 13 }))
})
