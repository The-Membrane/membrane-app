import assert from 'node:assert/strict'
import test from 'node:test'
import { eventKey } from './morpho-v2-cap-lifecycle-census.mjs'
import {
  buildPage,
  computePage,
  loadPageInputs,
  PAGE_SIZE,
  verifyPage,
} from './morpho-v2-control-pages.mjs'

const vault = (n) => `0x${n.toString(16).padStart(40, '0')}`
const asset = vault(999)
const anchor = { vault: vault(1), block: 1_000, timestamp: 1_000_000 }
const treatedCreation = { vault: vault(1), block: 1, timestamp: 100_000, asset }
const factoryEvents = [
  treatedCreation,
  ...Array.from({ length: 70 }, (_, i) => ({
    vault: vault(i + 2),
    block: i + 2,
    timestamp: 200_000 + i * 100,
    asset,
  })),
]
const prior = (n, timestamp) => ({
  vault: vault(n),
  block: 900,
  timestamp,
  selector: '0xf6f98fd5',
  data: '0xf6f98fd5',
})

test('later page is age-nearest clean order after unconditional recent and exact pending/ambiguous exclusions', () => {
  const recent = prior(2, 900_000),
    pending = prior(3, 300_000),
    ambiguous = prior(4, 300_000)
  const state = new Map([
    [eventKey(pending), { pending: true, ambiguous: false }],
    [eventKey(ambiguous), { pending: false, ambiguous: true }],
  ])
  const page = computePage({
    factoryEvents,
    rawEvents: [recent, pending, ambiguous],
    state,
    anchor,
    treatedCreation,
    offset: PAGE_SIZE,
  })
  assert.deepEqual(page.counts, {
    sameAssetPreAnchor: 70,
    recentSevenDay: 1,
    pending: 1,
    ambiguous: 1,
    clean: 67,
  })
  assert.equal(page.firstCleanCandidates.length, 32)
  assert.equal(page.candidates.length, 32)
  assert.equal(page.firstNextOffset, 32)
  assert.equal(page.nextCleanOffset, 64)
  const all = [...page.firstCleanCandidates, ...page.candidates]
  assert.equal(new Set(all.map((x) => x.vault)).size, 64)
  assert.ok(!all.some((x) => [vault(2), vault(3), vault(4)].includes(x.vault)))
  assert.equal(page.firstCleanCandidates[0].vault, vault(5))
})

test('offsets are whole clean pages and cannot exceed the risk set', () => {
  const base = { factoryEvents, rawEvents: [], state: new Map(), anchor, treatedCreation }
  assert.throws(() => computePage({ ...base, offset: 31 }), /Invalid frozen control-page input/)
  assert.throws(() => computePage({ ...base, offset: 0 }), /Invalid frozen control-page input/)
  const page = computePage({ ...base, offset: 64 })
  assert.equal(page.candidates.length, 6)
  assert.equal(page.nextCleanOffset, null)
})

test('real pinned sources reproduce sealed first32 before releasing offset32; tampering fails closed', () => {
  const { inputs, manifest } = loadPageInputs()
  const page = buildPage({ inputs, manifest, anchorIndex: 1, offset: 32 })
  assert.equal(page.candidates.length, 32)
  assert.equal(page.nextCleanOffset, 64)
  assert.equal(page.firstPageVerified, true)
  assert.equal(page.denominatorStatus, '304-anchor-study-incomplete')
  assert.equal(verifyPage(page, page), page)
  assert.throws(() => verifyPage({ ...page, candidates: [] }, page), /content or seal mismatch/)
  const altered = structuredClone(manifest)
  altered.rows[1].controls.firstCleanCandidates[0].vault = vault(123_456)
  assert.throws(
    () => buildPage({ inputs, manifest: altered, anchorIndex: 1, offset: 32 }),
    /Regenerated first page differs/,
  )
  assert.throws(
    () => buildPage({ inputs, manifest, anchorIndex: 0, offset: 32 }),
    /no continuation page/,
  )
})
