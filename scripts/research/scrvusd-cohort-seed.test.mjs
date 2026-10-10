import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SIZES,
  PAGE_SIZE,
  parseFirstPage,
  eligibleBySize,
  validateReceipt,
  save,
  verify,
  seedName,
} from './scrvusd-cohort-seed.mjs'

const sha = (v) => createHash('sha256').update(v).digest('hex')
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const address = (i) => `0x${i.toString(16).padStart(40, '0')}`
const identity = {
  chainId: 1,
  vault: address(999),
  crvUsd: address(998),
  pools: [],
  identitySha256: 'a'.repeat(64),
}
const anchor = { number: 100, hash: `0x${'b'.repeat(64)}`, timestamp: 1000 }
const checkpoint = {
  filename: `${String(anchor.number).padStart(12, '0')}-${anchor.hash.slice(2)}.json`,
  logicalSha256: 'c'.repeat(64),
  physicalSha256: 'd'.repeat(64),
  block: anchor,
}
const checkpoints = [
  {
    filename: checkpoint.filename,
    physicalSha256: checkpoint.physicalSha256,
    checkpoint: {
      sha256: checkpoint.logicalSha256,
      block: anchor,
      captureEndUtc: new Date(1000_500).toISOString(),
    },
  },
]
const nowMs = 1_004_000
function fixture({ eligible = 7, ambiguous = -1 } = {}) {
  const items = Array.from({ length: PAGE_SIZE }, (_, i) => ({
    address: { hash: address(i + 1) },
    value: String(1000 - i),
  }))
  const body = JSON.stringify({
    items,
    next_page_params: { value: '950', address_hash: address(50) },
  })
  const rows = parseFirstPage(JSON.parse(body))
  const results = rows.map((row, i) =>
    i === ambiguous
      ? {
          ...row,
          code: null,
          codeHash: null,
          balanceSharesRaw: null,
          maxWithdrawAssetsRaw: null,
          previewSharesRaw: null,
          readError: 'rpc_unavailable',
        }
      : {
          ...row,
          code: '0x',
          codeHash: null,
          balanceSharesRaw: i < eligible ? SIZES.at(-1) : '1',
          maxWithdrawAssetsRaw: i < eligible ? SIZES.at(-1) : '1',
          previewSharesRaw: Object.fromEntries(SIZES.map((q) => [q, q])),
          readError: null,
        },
  )
  const computed = eligibleBySize(results)
  const receipt = seal({
    study: 'scrvusd-cohort-seed-v1',
    kind: 'blockscout-first-page',
    source: identity,
    checkpoint: structuredClone(checkpoint),
    anchor: structuredClone(anchor),
    page: {
      url: `https://eth.blockscout.com/api/v2/tokens/${identity.vault}/holders`,
      httpStatus: 200,
      fetchedAtMs: 1_002_000,
      rawBody: body,
      rawBodySha256: sha(body),
      rawItems: items,
      rawNextPageParams: JSON.parse(body).next_page_params,
      rows,
    },
    captureStartMs: 1_001_000,
    captureEndMs: nowMs,
    vaultCodeHash: `0x${'e'.repeat(64)}`,
    asset: identity.crvUsd,
    sizesRaw: [...SIZES],
    vaultPreviewSharesRaw: Object.fromEntries(SIZES.map((q) => [q, q])),
    results,
    status: computed.status,
    eligible: computed.eligible,
    caveat:
      'One Blockscout first-page convenience sample. Listing is discovery metadata only; one RPC host attests pinned reads. No holder census, key-control proof, executable exit, independent validation, or population probability.',
  })
  return receipt
}
const valid = (receipt) => validateReceipt(receipt, { identity, checkpoints, nowMs })
const reseal = (receipt) =>
  seal(Object.fromEntries(Object.entries(receipt).filter(([k]) => k !== 'sha256')))
test('fixed grid and exact first page with continuation', () => {
  assert.equal(SIZES.length, 4)
  assert.equal(parseFirstPage(JSON.parse(fixture().page.rawBody)).length, 50)
  assert.throws(() => parseFirstPage({ items: [], next_page_params: { x: 1 } }))
  assert.throws(() =>
    parseFirstPage({
      items: Array.from({ length: 50 }, () => ({ address: { hash: address(1) }, value: '1' })),
      next_page_params: { x: 1 },
    }),
  )
})
test('eligibility applies share preview and full ambiguity fail-closed', () => {
  const r = valid(fixture())
  assert.equal(r.eligible[SIZES[0]].length, 7)
  const bad = fixture({ ambiguous: 49 })
  valid(bad)
  assert.equal(bad.status, 'unavailable')
  assert.deepEqual(bad.eligible[SIZES[0]], [])
  const preview = fixture()
  const tooMany = String(BigInt(preview.results[0].balanceSharesRaw) + 1n)
  preview.vaultPreviewSharesRaw[SIZES[0]] = tooMany
  for (const row of preview.results) row.previewSharesRaw[SIZES[0]] = tooMany
  const c = eligibleBySize(preview.results)
  preview.eligible = c.eligible
  preview.status = c.status
  valid(reseal(preview))
  assert.equal(c.eligible[SIZES[0]].includes(address(1)), false)
})
test('all candidate previews equal the sealed vault-wide grid', () => {
  const r = fixture()
  r.results[0].previewSharesRaw[SIZES[0]] = '1'
  assert.throws(() => valid(reseal(r)), /Pinned read shape/)
})

test('zero eligible is preserved; malformed status or page rejected', () => {
  assert.equal(valid(fixture({ eligible: 0 })).status, 'no_eligible')
  const r = fixture()
  r.page.rawNextPageParams = { value: 'another' }
  assert.throws(() => valid(reseal(r)), /Raw first page/)
  const s = fixture()
  s.status = 'sampled'
  s.eligible[SIZES[0]] = []
  assert.throws(() => valid(reseal(s)), /eligibility/)
})
test('source, clock, reorg reference and page splice rejected', () => {
  for (const edit of [
    (r) => {
      r.checkpoint.physicalSha256 = 'f'.repeat(64)
    },
    (r) => {
      r.captureEndMs = 1_100_000
    },
    (r) => {
      r.anchor.hash = `0x${'f'.repeat(64)}`
    },
    (r) => {
      r.page.rawBody = '{}'
    },
  ]) {
    const r = fixture()
    edit(r)
    assert.throws(() => valid(reseal(r)))
  }
})
test('one physical seed only, filename/bytes checked', () => {
  const out = mkdtempSync(join(tmpdir(), 'scrv-cohort-seed-'))
  const r = fixture()
  const stat = () => ({ bavail: 1e8, bsize: 1e6 })
  valid(r)
  const file = save({ receipt: r, out, identity, checkpoints, stat, nowMs })
  assert.equal(file, join(out, seedName(r)))
  assert.equal(verify({ out, identity, checkpoints, nowMs }).count, 1)
  assert.throws(
    () => save({ receipt: r, out, identity, checkpoints, stat, nowMs }),
    /already exists/,
  )
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, '000000000999-x.json'), readFileSync(file))
  assert.throws(() => verify({ out, identity, checkpoints, nowMs }), /Multiple/)
})
export { fixture, identity, checkpoints, nowMs, reseal }
