import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collect,
  buildExport,
  readExport,
  saveExport,
  VENUES,
  START,
  END,
} from './venue-intraday-export.mjs'

const configs = VENUES.map((name) => ({
  name,
  enabled: true,
  kind: name === 'aave-v3-usde' ? 'atoken-liquidity' : 'erc4626-cooldown',
  address: `0x${name}`,
  underlying: '0xunderlying',
  decimals: 18,
  depthMarkets:
    name === 'aave-v3-usde'
      ? []
      : [{ name: `${name} pool`, kind: 'psm-buffer', address: `0x${name}`, enabled: true }],
}))
const row = (at, venue = 'aave-v3-usde') => ({
  venue,
  block: 1,
  observed_at: at,
  instant_usd: null,
  params: { failed: true },
  source: 'observed',
})

test('bounded export preserves incomplete rows, fixed interval, ordering, and after-read fetch time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'venue-intraday-export-'))
  const out = join(dir, 'capture.json')
  let readFinished = false
  const physical = await collect({
    out,
    configs,
    statfs: () => ({ bavail: 2_147_483_648n, bsize: 1n }),
    query: async ({ names, start, end, limit }) => {
      assert.deepEqual(new Set(names), new Set(VENUES))
      assert.equal(start, START)
      assert.equal(end, END)
      assert.equal(limit, 15_001)
      readFinished = true
      return [row('2026-08-21T12:00:00Z'), row('2026-08-20T12:00:00Z')]
    },
    now: () => {
      assert.equal(readFinished, true)
      return '2026-09-26T12:00:00Z'
    },
  })
  const saved = readExport(out)
  assert.equal(saved.physicalSha256, physical)
  assert.equal(saved.payload.rows.length, 2)
  assert.equal(saved.payload.rows[0].params.failed, true)
  assert.equal(
    saved.payload.config.find((v) => v.name === 'aave-v3-usde').underlying,
    '0xunderlying',
  )
  assert.equal(saved.payload.rows[0].observed_at, '2026-08-20T12:00:00.000Z')
  assert.equal(saved.payload.fetchedAt, '2026-09-26T12:00:00Z')
  assert.throws(() => saveExport(out, buildExport([], configs)), /overwrite/)
  assert.throws(
    () =>
      saveExport(join(dir, 'no-space.json'), buildExport([], configs), () => ({
        bavail: 0n,
        bsize: 1n,
      })),
    /reserve/,
  )
  writeFileSync(out, readFileSync(out, 'utf8').replace('failed', 'changed'))
  assert.throws(() => readExport(out), /seal/i)
})

test('run refuses a 15001-row result before creating an artifact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'venue-intraday-limit-'))
  const out = join(dir, 'capture.json')
  await assert.rejects(
    collect({
      out,
      configs,
      query: async () => Array.from({ length: 15_001 }, () => row('2026-08-20T12:00:00Z')),
    }),
    /Row limit/,
  )
  assert.throws(() => readExport(out))
})
