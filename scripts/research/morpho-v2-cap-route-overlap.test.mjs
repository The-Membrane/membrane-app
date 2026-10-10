import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  compare, FACTORY_SHA, HEADERS_SHA, readPinned, seal, STAGE1_SHA,
  validateInputs, verify, windowMembership,
} from './morpho-v2-cap-route-overlap.mjs'

const root = 'data/research/venue-signals/'
const stagePath = `${root}morpho-v2-cap-submit-stage1.json`
const routePath = `${root}morpho-v2-route-address-headers.json`
const factoryPath = `${root}morpho-v2-factory-census.json`
const load = () => [readPinned(stagePath, STAGE1_SHA),
  readPinned(routePath, HEADERS_SHA), readPinned(factoryPath, FACTORY_SHA)]
const clone = (value) => structuredClone(value)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

test('pre and post endpoint inclusions are asymmetric and exclude the anchor', () => {
  const anchor = 1000, t = 100
  assert.equal(windowMembership(899, anchor, t), 'outside')
  assert.equal(windowMembership(900, anchor, t), 'pre')
  assert.equal(windowMembership(999, anchor, t), 'pre')
  assert.equal(windowMembership(1000, anchor, t), 'outside')
  assert.equal(windowMembership(1001, anchor, t), 'post')
  assert.equal(windowMembership(1100, anchor, t), 'post')
  assert.equal(windowMembership(1101, anchor, t), 'outside')
})

test('pinned local corpus yields complete paired denominators and spotcheck hits', () => {
  const [stage, route, factory] = load()
  const result = compare(stage, route, factory)
  assert.deepEqual(result.windows.map((w) => [w.completePairedAnchors,
    w.postAnchorHits, w.preAnchorHits]), [[298, 10, 16], [289, 16, 15], [283, 42, 26]])
  for (const w of result.windows) {
    assert.equal(w.both + w.postOnly + w.preOnly + w.neither, w.completePairedAnchors)
    assert.equal(w.postAnchorHits, w.both + w.postOnly)
    assert.equal(w.preAnchorHits, w.both + w.preOnly)
    assert.equal(w.postTransitionPairs, w.rows.reduce((n, x) => n + x.post.length, 0))
    assert.equal(w.preTransitionPairs, w.rows.reduce((n, x) => n + x.pre.length, 0))
    const excluded = new Set(Object.values(w.missing).flat())
    assert.equal(w.completePairedAnchors + excluded.size, 304)
    assert.equal(new Set(w.rows.map((x) => x.proposalIndex)).size, w.rows.length)
  }
  assert.deepEqual(verify(seal(result), stage, route, factory), seal(result))
})

test('source byte hashes are pinned and a changed factory/head gate fails closed', () => {
  const [stage, route, factory] = load()
  assert.equal(sha(readFileSync(stagePath)), STAGE1_SHA)
  assert.equal(sha(readFileSync(routePath)), HEADERS_SHA)
  assert.equal(sha(readFileSync(factoryPath)), FACTORY_SHA)
  assert.throws(() => readPinned(stagePath, '0'.repeat(64)), /SHA mismatch/)
  const changedHead = clone(stage)
  changedHead.pinnedHeadHash = '0x' + '0'.repeat(64)
  assert.throws(() => validateInputs(changedHead, route, factory), /pinned head/)
  const changedFactory = clone(factory)
  changedFactory.events.pop()
  assert.throws(() => validateInputs(stage, route, changedFactory), /Factory cohort/)
})

test('independence and route header integrity cannot silently drift', () => {
  const [stage, route, factory] = load()
  const duplicate = clone(stage)
  duplicate.summary.independentEligibleProposalIndexes[1] =
    duplicate.summary.independentEligibleProposalIndexes[0]
  assert.throws(() => validateInputs(duplicate, route, factory), /independent/)
  const changedRoute = clone(route)
  changedRoute.headers[0].timestamp++
  assert.throws(() => validateInputs(stage, changedRoute, factory), /checkpoint mismatch/)
  const result = seal(compare(stage, route, factory))
  result.windows[0].postAnchorHits++
  assert.throws(() => verify(result, stage, route, factory), /artifact mismatch/)
})
