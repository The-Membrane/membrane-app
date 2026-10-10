import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DENOMINATOR,
  loadFrozen,
  planRow,
  run,
  verifyCheckpoint,
} from './morpho-v2-full-cohort-controls-v2.mjs'

const plentyOfDisk = () => ({ bavail: 10_000_000, bsize: 4096 })

test('all 304 frozen anchors retain ITT identity and do not invent control results', () => {
  const frozen = loadFrozen()
  const rows = Array.from({ length: DENOMINATOR }, (_, i) => planRow(frozen, i))
  assert.equal(rows.length, 304)
  assert.equal(rows.filter((x) => x.screened.length > 0).length, 1)
  assert.equal(rows.filter((x) => x.selected.length > 0).length, 1)
  assert.equal(rows[0].screened.length, 4)
  assert.equal(rows[0].selected.length, 2)
  assert.equal(rows[64].disposition, 'treated-baseline-not-in-sealed-source')
  assert.equal(rows.filter((x) => x.noCleanCandidates).length, 6)
  assert.equal(rows.filter((x) => x.requiresContinuationPage).length, 211)
  assert.equal(rows.filter((x) => x.noCleanCandidates && !x.treatedInSealedSource).length, 3)
  assert.equal(
    rows.filter((x) => x.requiresContinuationPage && !x.treatedInSealedSource).length,
    170,
  )
  for (let i = 0; i < rows.length; i++) {
    assert.equal(rows[i].proposalIndex, frozen.manifest.rows[i].proposalIndex)
    assert.equal(rows[i].vault, frozen.manifest.rows[i].vault)
    assert.equal(rows[i].cleanCandidates, frozen.manifest.rows[i].controls.counts.clean)
  }
  assert.ok(rows.some((x) => x.disposition === 'no-clean-control-candidates'))
  assert.ok(rows.some((x) => x.disposition === 'unsupported-screening-and-continuation'))
})

test('bounded local checkpoint resumes atomically and verifier rejects changed selection', () => {
  const frozen = loadFrozen()
  const dir = mkdtempSync(join(tmpdir(), 'morpho-controls-stage-'))
  const out = join(dir, 'checkpoint.json')
  try {
    let saved = run({ frozen, out, maxAnchors: 1, stat: plentyOfDisk })
    assert.equal(saved.rows.length, 1)
    assert.equal(saved.liveRpcUsed, false)
    saved = run({ frozen, out, maxAnchors: 32, stat: plentyOfDisk })
    assert.equal(saved.rows.length, 33)
    assert.equal(verifyCheckpoint(JSON.parse(readFileSync(out, 'utf8')), frozen).rows.length, 33)
    for (let i = 33; i < DENOMINATOR; i += 32) {
      saved = run({ frozen, out, maxAnchors: 32, stat: plentyOfDisk })
    }
    assert.equal(saved.rows.length, DENOMINATOR)
    assert.equal(saved.status, 'plan-complete-controls-partial')
    assert.equal(saved.rows.filter((x) => x.selected.length > 0).length, 1)
    saved.rows[0].selected = []
    const { checkpointSha256: _oldSeal, ...unsigned } = saved
    saved.checkpointSha256 = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex')
    assert.throws(() => verifyCheckpoint(saved, frozen), /row mismatch/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('invalid frontier and candidate-page mutation fail closed', () => {
  const frozen = loadFrozen()
  assert.throws(() => planRow(frozen, -1), /Invalid anchor/)
  assert.throws(
    () => run({ frozen, out: '/tmp/nope', maxAnchors: 33, stat: plentyOfDisk }),
    /Invalid bounded/,
  )
  assert.throws(
    () =>
      run({
        frozen,
        out: '/tmp/nope',
        maxAnchors: 1,
        stat: () => ({ bavail: 1, bsize: 1 }),
      }),
    /Disk reserve/,
  )
  const changed = structuredClone(frozen)
  changed.manifest.rows[0].controls.firstCleanCandidates[0].vault = changed.manifest.rows[0].vault
  assert.throws(() => planRow(changed, 0), /candidate page mismatch/)
})
