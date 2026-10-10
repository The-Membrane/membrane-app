import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { build, readSnapshot, save, STUDY } from './aave-calendar-identity-corroboration.mjs'

const base = 'data/research/venue-signals/'
const paths = {
  witnessPath: resolve(`${base}aave-core-holder-witness-2026-09-26.json`),
  slopePath: resolve(`${base}aave-core-cash-slope-2026-09-26.json`),
  outcomePath: resolve(`${base}aave-core-holder-outcomes-calendar-v1.json`),
}

test('sealed pre-target slope corroborates identity without rewriting censored outcome', () => {
  const result = build(paths)
  assert.equal(result.study, STUDY)
  assert.equal(result.originalOutcomeRemainsCensored, true)
  assert.equal(result.prospectiveAlertClaim, false)
  assert.equal(result.identityObservedAtB, false)
  assert.equal(result.slopeFirstKnownLeadSeconds, 18658)
  assert.equal(result.meetsSixHourLead, false)
  assert.equal(result.horizon, '6h')
  assert.equal(result.outcomeBlock, 26_061_422)
  assert.ok(result.slopeFirstKnownAtMs < result.targetTimestamp * 1000)
  assert.deepEqual(
    result.markets.map((market) => market.witnesses.length),
    [2, 1],
  )
  assert.ok(result.markets.every((market) => market.sameImplementation))
  assert.ok(
    result.markets
      .flatMap((market) => market.witnesses)
      .every(
        (row) =>
          row.identityCorroboratedSuccess &&
          row.originalCensoring[0] === 'pool-implementation-unresolved',
      ),
  )
})

test('physical source mutation is rejected even if JSON remains parseable', () => {
  const dir = mkdtempSync(`${tmpdir()}/aave-corroboration-`)
  const copy = resolve(dir, 'slope.json')
  writeFileSync(copy, `${readFileSync(paths.slopePath, 'utf8')} `)
  assert.throws(() => build({ ...paths, slopePath: copy }), /physical SHA changed/)
})

test('versioned sidecar is sealed and refuses overwrite', () => {
  const result = build(paths)
  const out = resolve(mkdtempSync(`${tmpdir()}/aave-corroboration-`), 'sidecar.json')
  const physical = save(out, result)
  assert.equal(createHash('sha256').update(readFileSync(out)).digest('hex'), physical)
  assert.equal(readSnapshot(out, paths).payload.study, STUDY)
  assert.throws(() => save(out, result), /Refusing to overwrite/)
})
