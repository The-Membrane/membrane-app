import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import {
  DEFAULT_PATHS,
  issue,
  preview,
  readAsOf,
  verifyAll,
  verifyReceipt,
} from './morpho-exit-panel-snapshot.mjs'

const before = (value) => new Date(Date.parse(value) - 1).toISOString()
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'morpho-panel-snapshot-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('real source preview preserves frozen cohort, two clocks, and missingness', () => {
  const dry = preview()
  const summary = dry.summary
  assert.equal(dry.status, 'dry-unissued')
  assert.equal(dry.issuedAtUtc, undefined)
  assert.equal(dry.sha256, undefined)
  assert.equal(summary.counts.frozenRows, 64)
  assert.equal(summary.counts.baselineEligible, 58)
  assert.equal(summary.counts.missingBaseline, 57)
  assert.equal(summary.counts.missingSamples, 114)
  assert.equal(summary.counts.cleanSuccessSamples, 2)
  assert.equal(summary.dependence.uniqueHolders, 48)
  assert.equal(summary.dependence.uniqueVaults, 44)
  assert.equal(summary.counts.pairsWithConcurrentEligibleScheduledActions, 52)
  assert.equal(summary.forecast.status, 'unavailable')
  const row = summary.rows[0]
  assert.equal(row.episode.startBasis, 'pre-block-baseline')
  assert.equal(row.episode.startTimestamp, row.anchorTimestamp - 12)
  assert.equal(row.scheduledTargets.plus24h, row.executableAtTimestamp + 86400)
  assert.equal(row.scheduledTargets.plus7d, row.executableAtTimestamp + 604800)
  assert.equal(row.samples[0].targetElapsedFromExecutableSeconds, 86400)
  assert.equal(row.samples[1].targetElapsedFromExecutableSeconds, 604800)
  assert.equal(row.eligibleScheduledActionCountAtFirstExecutableAt, 2)
  assert.equal(row.singleActionAttribution.status, 'unavailable')
})

test('issue copies exact source, seals summary, and reissue is idempotent', (t) => {
  const dir = fixture(t)
  const start = Date.now()
  const first = issue({ dir })
  const end = Date.now()
  assert.equal(first.status, 'issued')
  assert.equal(first.receipt.version, 3)
  assert.equal(first.receipt.issueClock, 'local-operator-system-clock-claim')
  assert.ok(Date.parse(first.receipt.issuedAtUtc) >= start)
  assert.ok(Date.parse(first.receipt.issuedAtUtc) <= end)
  assert.deepEqual(
    readFileSync(join(dir, first.receipt.source.filename)),
    readFileSync(DEFAULT_PATHS.out),
  )
  for (const [name, path] of Object.entries({
    treated: DEFAULT_PATHS.treatedPath,
    manifest: DEFAULT_PATHS.manifestPath,
    factory: DEFAULT_PATHS.factoryPath,
    stage1: DEFAULT_PATHS.stage1Path,
  })) {
    const ref = first.receipt.source.ancestryRefs[name]
    assert.equal(ref.originalFilename, basename(path))
    assert.deepEqual(readFileSync(join(dir, ref.filename)), readFileSync(path))
    assert.equal(ref.physicalSha256, createHash('sha256').update(readFileSync(path)).digest('hex'))
  }
  const second = issue({ dir })
  assert.equal(second.status, 'existing')
  assert.equal(second.receipt.issuedAtUtc, first.receipt.issuedAtUtc)
  assert.equal(verifyAll({ dir }).length, 1)
})

test('as-of excludes receipts issued after cutoff', (t) => {
  const dir = fixture(t)
  const saved = issue({ dir })
  const at = saved.receipt.issuedAtUtc
  assert.equal(readAsOf({ dir, asOfUtc: before(at) }), null)
  assert.equal(readAsOf({ dir, asOfUtc: at }).receipt.issuedAtUtc, at)
  assert.throws(() => readAsOf({ dir, asOfUtc: 'yesterday' }), /Invalid as-of UTC/)
})

test('mutable source drift cannot replace an issued copied source', (t) => {
  const dir = fixture(t)
  const original = issue({ dir })
  const mutable = join(dir, 'mutable.json')
  writeFileSync(mutable, readFileSync(DEFAULT_PATHS.out))
  const edited = JSON.parse(readFileSync(mutable))
  edited.rows[0].qAssets = '999999'
  writeFileSync(mutable, JSON.stringify(edited))
  assert.throws(
    () => preview({ paths: { ...DEFAULT_PATHS, out: mutable } }),
    /checkpoint|Frozen|mismatch/i,
  )
  assert.equal(
    verifyReceipt({ filename: original.filename, dir }).receipt.source.physicalSha256,
    original.receipt.source.physicalSha256,
  )
})

test('a later valid physical checkpoint revision leaves the old receipt replayable', async (t) => {
  const dir = fixture(t)
  const mutable = join(dir, 'mutable.json')
  const firstBytes = readFileSync(DEFAULT_PATHS.out)
  writeFileSync(mutable, firstBytes)
  const paths = { ...DEFAULT_PATHS, out: mutable }
  const first = issue({ dir, paths })
  await new Promise((done) => setTimeout(done, 5))
  writeFileSync(mutable, Buffer.concat([firstBytes, Buffer.from(' ')]))
  const second = issue({ dir, paths })
  assert.equal(second.status, 'issued')
  assert.notEqual(first.filename, second.filename)
  assert.equal(
    readAsOf({ dir, paths, asOfUtc: first.receipt.issuedAtUtc }).filename,
    first.filename,
  )
  assert.equal(
    readAsOf({ dir, paths, asOfUtc: second.receipt.issuedAtUtc }).filename,
    second.filename,
  )
  assert.equal(
    verifyReceipt({ filename: first.filename, dir, paths }).receipt.issuedAtUtc,
    first.receipt.issuedAtUtc,
  )
})

test('receipt and copied-source corruption fail replay', (t) => {
  const dir = fixture(t)
  const saved = issue({ dir })
  const receiptPath = join(dir, saved.filename)
  const bytes = readFileSync(receiptPath)
  writeFileSync(receiptPath, Buffer.concat([bytes, Buffer.from(' ')]))
  assert.throws(() => verifyReceipt({ filename: saved.filename, dir }), /physical bytes changed/)
  writeFileSync(receiptPath, bytes)
  const sourcePath = join(dir, saved.receipt.source.filename)
  writeFileSync(sourcePath, Buffer.concat([readFileSync(sourcePath), Buffer.from(' ')]))
  assert.throws(() => verifyReceipt({ filename: saved.filename, dir }), /physical SHA mismatch/)
})

test('copied ancestry corruption fails, while missing original paths do not affect v3 replay', (t) => {
  const dir = fixture(t)
  const saved = issue({ dir })
  const missing = Object.fromEntries(
    Object.entries(DEFAULT_PATHS).map(([key]) => [key, join(dir, 'does-not-exist', key)]),
  )
  assert.equal(verifyReceipt({ filename: saved.filename, dir, paths: missing }).receipt.version, 3)
  const manifestPath = join(dir, saved.receipt.source.ancestryRefs.manifest.filename)
  writeFileSync(manifestPath, Buffer.concat([readFileSync(manifestPath), Buffer.from(' ')]))
  assert.throws(
    () => verifyReceipt({ filename: saved.filename, dir, paths: missing }),
    /Ancestry manifest physical SHA changed/,
  )
})

test('v3 accepts equivalent pinned ancestry bytes under alternate source filenames', (t) => {
  const dir = fixture(t)
  const paths = { ...DEFAULT_PATHS }
  for (const key of ['treatedPath', 'manifestPath', 'factoryPath', 'stage1Path']) {
    const alternate = join(dir, `alternate-${key}.json`)
    writeFileSync(alternate, readFileSync(paths[key]))
    paths[key] = alternate
  }
  const saved = issue({ dir, paths })
  assert.equal(saved.receipt.version, 3)
  assert.equal(verifyReceipt({ filename: saved.filename, dir }).receipt.version, 3)
})

test('v1 and v2 receipts remain replayable after v3 issue', (t) => {
  const dir = fixture(t)
  const v3 = issue({ dir })
  const v2 = structuredClone(v3.receipt)
  delete v2.sha256
  v2.study = 'morpho-exit-panel-snapshot-v2'
  v2.version = 2
  delete v2.issueClock
  for (const [name, path] of Object.entries({
    treated: DEFAULT_PATHS.treatedPath,
    manifest: DEFAULT_PATHS.manifestPath,
    factory: DEFAULT_PATHS.factoryPath,
    stage1: DEFAULT_PATHS.stage1Path,
  }))
    v2.source.ancestryRefs[name] = {
      filename: basename(path),
      physicalSha256: v2.source.ancestryRefs[name].physicalSha256,
    }
  v2.sha256 = createHash('sha256').update(JSON.stringify(v2)).digest('hex')
  const v2name = `snapshot-v2-${v2.source.physicalSha256}.json`
  writeFileSync(join(dir, v2name), `${JSON.stringify(v2)}\n`)
  const v1 = structuredClone(v2)
  delete v1.sha256
  v1.study = 'morpho-exit-panel-snapshot-v1'
  v1.version = 1
  delete v1.source.ancestryRefs
  delete v1.evidenceScope.chainId
  v1.issuedAtUtc = before(v3.receipt.issuedAtUtc)
  v1.sha256 = createHash('sha256').update(JSON.stringify(v1)).digest('hex')
  const name = `snapshot-${v1.source.physicalSha256}.json`
  writeFileSync(join(dir, name), `${JSON.stringify(v1)}\n`)
  assert.equal(verifyReceipt({ filename: name, dir }).receipt.version, 1)
  assert.equal(verifyReceipt({ filename: v2name, dir }).receipt.version, 2)
  assert.equal(readAsOf({ dir, asOfUtc: v1.issuedAtUtc }), null)
  assert.equal(readAsOf({ dir, asOfUtc: v3.receipt.issuedAtUtc }).filename, v3.filename)
  assert.equal(verifyAll({ dir }).length, 3)
})

test('caller cannot backdate an issue or make dry preview look issued', (t) => {
  const dir = fixture(t)
  assert.throws(() => issue({ dir, issuedAtUtc: '2020-01-01T00:00:00.000Z' }), /system controlled/)
  assert.throws(() => preview({ issuedAtUtc: '2020-01-01T00:00:00.000Z' }), /Dry preview/)
  assert.equal(verifyAll({ dir }).length, 0)
})
