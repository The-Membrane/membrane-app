import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { SIZES, seedName, eligibleBySize } from './scrvusd-cohort-seed.mjs'
import { makePlan, validatePlan } from './scrvusd-cohort-plan.mjs'
import { fixture, identity, checkpoints, reseal } from './scrvusd-cohort-seed.test.mjs'
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const address = (i) => `0x${i.toString(16).padStart(40, '0')}`
function sources({ eligible = 7, pilotHolder = address(1), ambiguous = -1 } = {}) {
  const seed = fixture({ eligible, ambiguous }),
    seedBytes = Buffer.from(`${JSON.stringify(seed)}\n`),
    pilot = { holder: pilotHolder, sha256: 'a'.repeat(64) },
    pilotBytes = Buffer.from(`${JSON.stringify(pilot)}\n`)
  const pilotSelection = {
    holder: pilotHolder,
    sha256: 'b'.repeat(64),
    capturedUtc: new Date(900_000).toISOString(),
    plan: { logicalSha256: pilot.sha256, physicalSha256: sha(pilotBytes) },
  }
  const pilotSelectionBytes = Buffer.from(`${JSON.stringify(pilotSelection)}\n`)
  const localCheckpoints = structuredClone(checkpoints)
  return {
    identity,
    checkpoints: localCheckpoints,
    checkpoint: localCheckpoints[0],
    seed,
    seedBytes,
    seedFilename: seedName(seed),
    pilot,
    pilotBytes,
    pilotSelection,
    pilotSelectionBytes,
  }
}
const plan = (s) =>
  makePlan({ sources: s, createdUtc: new Date(1_005_000).toISOString(), nowMs: 1_005_000 })
test('fixed four-size first-five roster excludes pilot and preserves overlap', () => {
  const s = sources(),
    p = plan(s)
  assert.deepEqual(p.sizesRaw, SIZES)
  assert.equal(p.excludedPilot.holder, address(1))
  for (const stratum of p.strata) {
    assert.equal(stratum.holders.length, 5)
    assert.deepEqual(stratum.holders, [2, 3, 4, 5, 6].map(address))
    assert.equal(stratum.eligibleAfterExclusion, 6)
  }
  assert.equal(validatePlan(p, { sources: s, nowMs: 1_005_000 }).sha256, p.sha256)
})
test('fewer and zero strata remain explicit', () => {
  const p = plan(sources({ eligible: 2 }))
  assert.equal(p.strata[0].holders.length, 1)
  const zero = plan(sources({ eligible: 0 }))
  assert.equal(zero.status, 'no_eligible')
  assert.ok(zero.strata.every((s) => s.status === 'no_eligible' && s.holders.length === 0))
})
test('ambiguous candidate and earlier local plan clock fail closed', () => {
  assert.throws(() => plan(sources({ ambiguous: 49 })), /not prospective/)
  const s = sources()
  assert.throws(
    () => makePlan({ sources: s, createdUtc: new Date(1_003_000).toISOString(), nowMs: 1_005_000 }),
    /not prospective/,
  )
})
test('later already-captured checkpoint and pilot spoof fail closed', () => {
  const s = sources()
  s.checkpoints.push({
    checkpoint: { block: { number: 101 }, captureEndUtc: new Date(1_004_500).toISOString() },
  })
  assert.throws(() => plan(s), /not prospective/)
  const t = sources()
  t.pilotSelection.plan.physicalSha256 = 'f'.repeat(64)
  assert.throws(() => plan(t), /exclusion/)
})
test('roster tamper and source physical changes invalidate', () => {
  const s = sources(),
    p = plan(s)
  p.strata[0].holders[0] = address(49)
  assert.throws(() => validatePlan(p, { sources: s, nowMs: 1_005_000 }), /seal/)
  const t = sources()
  t.seedBytes = Buffer.from(JSON.stringify(t.seed))
  assert.throws(() => plan(t), /source/)
})

test('rank uses pinned maxWithdraw with address tie-break, not listed order', () => {
  const s = sources({ eligible: 7, pilotHolder: address(50) })
  s.seed.results[6].maxWithdrawAssetsRaw = String(BigInt(SIZES.at(-1)) + 100n)
  s.seed.results[4].maxWithdrawAssetsRaw = String(BigInt(SIZES.at(-1)) + 1n)
  const classified = eligibleBySize(s.seed.results)
  s.seed.eligible = classified.eligible
  s.seed.status = classified.status
  s.seed = reseal(s.seed)
  s.seedBytes = Buffer.from(`${JSON.stringify(s.seed)}\n`)
  s.seedFilename = seedName(s.seed)
  const p = plan(s)
  assert.deepEqual(p.strata[0].holders, [7, 5, 1, 2, 3].map(address))
})
