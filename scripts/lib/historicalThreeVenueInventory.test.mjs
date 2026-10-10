import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  appendHistoricalThreeVenueInventory,
  decodeInventory,
  manifestFromConfig,
  nextHistoricalBlock,
  readHistoricalThreeVenueInventory,
  readHistoricalInventoryAt,
  verifyHistoricalThreeVenueInventory,
} from './historicalThreeVenueInventory.mjs'
import { parseOptions } from '../record-historical-three-venue-inventory.mjs'

const manifest = manifestFromConfig()
const values = () => [
  manifest.sUSDe.output,
  manifest.sUSDe.input,
  18,
  50_000_000n * 10n ** 18n,
  manifest.sUSDS.pocket,
  manifest.sUSDS.output,
  6,
  4_000_000_000n * 10n ** 6n,
  manifest.sGHO.underlying,
  18,
  18,
  false,
  20_000_000n * 10n ** 18n,
]
const h = (n) => `0x${n.toString(16).padStart(64, '0')}`

test('pinned exact route identities yield output inventory, not holder capacity', () => {
  const v = decodeInventory(values(), manifest)
  assert.equal(v.sUSDe.inventoryUsdAssumingPeg, 50_000_000)
  assert.equal(v.sUSDS.inventoryUsdAssumingPeg, 4_000_000_000)
  assert.equal(v.sUSDS.holderAttribution, 'unavailable')
  assert.equal(v.sGHO.inventoryUsdAssumingPeg, 20_000_000)
  const paused = values()
  paused[11] = true
  const p = decodeInventory(paused, manifest)
  assert.equal(p.sGHO.inventoryUsdAssumingPeg, 0)
  assert.equal(p.sGHO.rawCashUsdAssumingPeg, 20_000_000)
})

test('every stale identity, including Curve coins and Pocket, fails closed', () => {
  for (const slot of [0, 1, 4, 5, 8]) {
    const v = values()
    v[slot] = '0x0000000000000000000000000000000000000001'
    assert.throws(() => decodeInventory(v, manifest), /pinned_identity_mismatch/)
  }
  for (const slot of [2, 6, 9, 10]) {
    const v = values()
    v[slot] = 9
    assert.throws(() => decodeInventory(v, manifest), /pinned_identity_mismatch/)
  }
})

test('source hash is re-read around pinned multicall', async () => {
  let headers = 0
  const client = {
    getChainId: async () => 1,
    getBlock: async () => ({ number: 2_000n, hash: h(++headers), timestamp: 1_800_000_000n }),
    multicall: async ({ blockNumber, allowFailure }) => {
      assert.equal(blockNumber, 2_000n)
      assert.equal(allowFailure, false)
      return values()
    },
  }
  await assert.rejects(readHistoricalInventoryAt(client, 2_000n, manifest), /source_changed/)
})

test('append and replay enforce backward 900-block continuity and reject resealed amount tampering', () => {
  const out = mkdtempSync(join(tmpdir(), 'three-venue-history-'))
  try {
    const now = () => new Date('2026-09-30T23:00:00.000Z')
    const point = (block, timestamp) => ({
      source: {
        block: String(block),
        hash: h(block),
        timestamp,
        pinned: true,
        finalizedAtCapture: true,
      },
      inventory: decodeInventory(values(), manifest),
    })
    const anchor = Date.parse('2026-09-30T21:00:00.000Z') / 1000
    const a = appendHistoricalThreeVenueInventory(point(26_000_000, anchor), { out, manifest, now })
    const b = appendHistoricalThreeVenueInventory(point(25_999_100, anchor - 10_800), {
      out,
      manifest,
      now,
    })
    assert.equal(b.previousSha256, a.sha256)
    assert.equal(verifyHistoricalThreeVenueInventory(out, manifest).count, 2)
    assert.equal(readHistoricalThreeVenueInventory(out, manifest).rows.length, 2)
    assert.equal(nextHistoricalBlock(27_000_000n, b), 25_998_200n)
    assert.throws(
      () =>
        appendHistoricalThreeVenueInventory(point(25_998_201, anchor - 21_600), {
          out,
          manifest,
          now,
        }),
      /chain_invalid/,
    )
    const path = join(out, '000002.json')
    const record = JSON.parse(readFileSync(path, 'utf8'))
    record.inventory.sUSDS.raw = '1'
    const { sha256, ...body } = record
    record.sha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    writeFileSync(path, `${JSON.stringify(record)}\n`)
    assert.throws(() => verifyHistoricalThreeVenueInventory(out, manifest), /amount_invalid/)
    record.inventory.sUSDS.raw = String(4_000_000_000n * 10n ** 6n)
    record.firstLocalReceiptAtUtc = 'not-a-date'
    const { sha256: ignored, ...timeBody } = record
    record.sha256 = createHash('sha256').update(JSON.stringify(timeBody)).digest('hex')
    writeFileSync(path, `${JSON.stringify(record)}\n`)
    assert.throws(() => verifyHistoricalThreeVenueInventory(out, manifest), /invalid_receipt_time/)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('CLI stays bounded', () => {
  assert.deepEqual(parseOptions(['--capture', '--batch', '8']), {
    mode: 'capture',
    batch: 8,
    maxDays: 400,
  })
  assert.throws(() => parseOptions(['--capture', '--batch', '65']), /invalid_options/)
  assert.throws(() => parseOptions(['--capture', '--max-days', '401']), /invalid_options/)
})
