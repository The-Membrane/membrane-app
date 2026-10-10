import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  readSync,
  renameSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROFILE,
  LIMITS,
  OUTPUTS,
  generateSampledCashHistoryArtifacts,
  serializedArtifacts,
  preflightDirectory,
  frozenPrefix,
  parseArguments,
  writeArtifacts,
  checkArtifacts,
} from './carry-sampled-cash-history-pins.mjs'
import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'
import { verifyLocalCarryCash } from '../lib/localCarryCashStore.mjs'
const hash = (s) => createHash('sha256').update(s).digest('hex')
const fixture = await generateSampledCashHistoryArtifacts()
const files = serializedArtifacts(fixture)
const temporary = (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'sampled-pins-test-'))
  try {
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
test('exact parity with all64 existing embedded pins, including native units and witnesses', () => {
  const source = readFileSync('lib/carry/conditionalSampledCashPathProjection.ts', 'utf8')
  const table = source.slice(
    source.indexOf('const HISTORY_PINS:'),
    source.indexOf('/** Trusted native identity'),
  )
  const entries = [
    ...table.matchAll(
      /^  '(.*?)':\n    \{\n      assetDecimals: (\d+),\n      compactSha256: '(.*?)',\n      manifestSha256: '(.*?)',\n      lastDailyReceiptSha256: '(.*?)',\n      availableAt: '(.*?)',/gm,
    ),
  ]
  assert.equal(entries.length, 64)
  for (const [
    ,
    key,
    decimals,
    compactSha256,
    manifestSha256,
    lastDailyReceiptSha256,
    availableAt,
  ] of entries) {
    const id = key.replaceAll('\\u0000', '\0')
    assert.deepEqual(fixture.pins.pins[id], {
      assetDecimals: Number(decimals),
      compactSha256,
      manifestSha256,
      lastDailyReceiptSha256,
      availableAt,
    })
    assert.equal(hash(JSON.stringify(fixture.audit.histories[id])), compactSha256)
  }
})
test('fixed divergent cutoffs, native counts, full points and predeployment/gap invariants', () => {
  const histories = Object.values(fixture.audit.histories)
  assert.equal(histories.length, 64)
  assert.equal(new Set(histories.map((h) => h.identity.routeKey)).size, 22)
  assert.equal(
    histories.reduce((n, h) => n + h.points.length, 0),
    7669,
  )
  assert.equal(histories.filter((h) => h.points.length === 109).length, 1)
  for (const h of histories) {
    const lane = PROFILE.lanes.find((l) => l.manifestSha256 === h.witness.manifestSha256)
    assert.equal(h.coverage.gridToAnchorAt, lane.anchorEnd)
    assert.equal(h.coverage.gridAnchorCount, 120)
    assert.equal(h.coverage.interiorUnavailableAnchorCount, 0)
    assert.equal(h.coverage.trailingUnavailableAnchorCount, 0)
    assert.equal(h.points.length, h.coverage.observedAnchorCount)
    assert.ok(
      h.points.every((p, i) => p[0] >= 0 && p[0] < 120 && (i === 0 || p[0] > h.points[i - 1][0])),
    )
  }
  assert.equal(fixture.audit.exclusions.length, 4)
  assert.ok(fixture.audit.exclusions.every((e) => e.reason === 'foreign_final_payout'))
})
test('deterministic artifacts match checked-in bytes and are deeply immutable', async () => {
  assert.deepEqual(serializedArtifacts(await generateSampledCashHistoryArtifacts()), files)
  for (const k of ['pins', 'audit']) assert.equal(readFileSync(OUTPUTS[k], 'utf8'), files[k])
  assert.equal(Object.isFrozen(PROFILE.lanes[0]), true)
  const pin = Object.values(fixture.pins.pins)[0],
    h = Object.values(fixture.audit.histories)[0]
  assert.equal(Reflect.set(pin, 'compactSha256', 'forged'), false)
  assert.equal(Reflect.set(h.points[0], 4, '1'), false)
  assert.ok(Buffer.byteLength(files.pins) < 34000)
  assert.ok(Buffer.byteLength(files.audit) < LIMITS.artifactBytes)
})
test('CLI rejects unregistered roots/history/assets/cutoffs/version and extra flags', () => {
  assert.equal(parseArguments(['check', '--cohort', PROFILE.cohort, '--version', '1']), 'check')
  for (const args of [
    [],
    ['check', '--cohort', 'foreign', '--version', '1'],
    ['generate', '--cohort', PROFILE.cohort, '--version', '2'],
    ['check', '--root', '/tmp', '--version', '1'],
    ['check', '--history', 'foreign', '--version', '1'],
    ['check', '--asset', 'foreign', '--version', '1'],
    ['check', '--cohort', PROFILE.cohort, '--version', '1', '--anchor-end', '2026-10-03'],
  ])
    assert.throws(() => parseArguments(args), /profile_or_arguments/)
})
test('preflight rejects oversize, symlink, unknown/gapped names and excessive count before receipt reads', () => {
  temporary((root) => {
    writeFileSync(join(root, '000000000001.json'), '1234')
    assert.throws(() => preflightDirectory(root, 3), /oversize/)
  })
  temporary((root) => {
    writeFileSync(join(root, '000000000002.json'), '{}')
    assert.throws(() => preflightDirectory(root, 10), /sequence/)
  })
  temporary((root) => {
    symlinkSync('/dev/null', join(root, '000000000001.json'))
    assert.throws(() => preflightDirectory(root, 10), /file_invalid/)
  })
  temporary((root) => {
    for (let i = 1; i <= 513; i++)
      writeFileSync(join(root, `${String(i).padStart(12, '0')}.json`), '')
    assert.throws(() => preflightDirectory(root, 10), /count_limit/)
  })
})
test('changed canonical bytes or resealed previous link fails actual SHA-chain verifier', async () => {
  const manifest = await buildSubjectManifest()
  const first = readFileSync(join(PROFILE.lanes[0].root, '000000000001.json'), 'utf8')
  temporary((root) => {
    writeFileSync(join(root, '000000000001.json'), first + ' ')
    assert.throws(() => verifyLocalCarryCash(manifest, root), /physical_bytes/)
  })
  temporary((root) => {
    const r = JSON.parse(first)
    r.previousSha256 = '0'.repeat(64)
    const { sha256, ...body } = r
    r.sha256 = hash(JSON.stringify(body))
    writeFileSync(join(root, '000000000001.json'), JSON.stringify(r) + '\n')
    assert.throws(() => verifyLocalCarryCash(manifest, root), /receipt_identity/)
  })
})
test('fixed prefix ignores later records but rejects truncated or changed prefix witness', () => {
  const lane = { prefixCount: 2, prefixHeadSha256: 'good' }
  const records = [{ sha256: 'first' }, { sha256: 'good' }, { sha256: 'appended-backfill' }]
  assert.deepEqual(frozenPrefix({ count: 3, records }, lane).records, records.slice(0, 2))
  assert.throws(
    () => frozenPrefix({ count: 1, records: records.slice(0, 1) }, lane),
    /prefix_mismatch/,
  )
  assert.throws(
    () => frozenPrefix({ count: 3, records }, { ...lane, prefixHeadSha256: 'bad' }),
    /prefix_mismatch/,
  )
})
test('exclusive writer rejects overwrite, insufficient reserve and oversize; leaves existing bytes unchanged', () => {
  temporary((root) => {
    const paths = { pins: join(root, 'pins.json'), audit: join(root, 'audit.json') }
    writeArtifacts(files, paths, LIMITS.reserveBytes + 2 * LIMITS.artifactBytes)
    assert.equal(readFileSync(paths.pins, 'utf8'), files.pins)
    assert.throws(() => writeArtifacts(files, paths, 10 ** 10), /output_exists/)
    assert.equal(readFileSync(paths.pins, 'utf8'), files.pins)
  })
  temporary((root) => {
    const paths = { pins: join(root, 'pins.json'), audit: join(root, 'audit.json') }
    assert.throws(() => writeArtifacts(files, paths, LIMITS.reserveBytes), /disk_reserve/)
    assert.throws(
      () =>
        writeArtifacts({ ...files, pins: 'x'.repeat(LIMITS.artifactBytes + 1) }, paths, 10 ** 10),
      /artifact_oversize/,
    )
  })
})

for (const failingWrite of [1, 2])
  test(`owned partial write ${failingWrite} cleans the pair and permits retry`, () => {
    temporary((root) => {
      const paths = { pins: join(root, 'pins.json'), audit: join(root, 'audit.json') }
      let writes = 0
      assert.throws(
        () =>
          writeArtifacts(files, paths, 10 ** 10, (fd, bytes) => {
            writes++
            if (writes === failingWrite) {
              writeFileSync(fd, bytes.slice(0, 9))
              throw Object.assign(Error('injected_partial_write'), { code: 'ENOSPC' })
            }
            writeFileSync(fd, bytes)
          }),
        /injected_partial_write/,
      )
      assert.equal(existsSync(paths.pins), false)
      assert.equal(existsSync(paths.audit), false)
      writeArtifacts(files, paths, 10 ** 10)
      assert.equal(readFileSync(paths.pins, 'utf8'), files.pins)
      assert.equal(readFileSync(paths.audit, 'utf8'), files.audit)
    })
  })

test('both actual verifiers enforce post-preflight appended count, replaced files and total bytes', async () => {
  const manifest = await buildSubjectManifest()
  const { buildSupplementalAaveUsdeCashManifest, verifyLocalSupplementalAaveUsdeCash } =
    await import('../lib/localSupplementalAaveUsdeCashStore.mjs')
  const supplemental = await buildSupplementalAaveUsdeCashManifest({ issueManifest: manifest })
  for (const [lane, m, verify] of [
    [PROFILE.lanes[0], manifest, verifyLocalCarryCash],
    [PROFILE.lanes[1], supplemental, verifyLocalSupplementalAaveUsdeCash],
  ]) {
    const first = readFileSync(join(lane.root, '000000000001.json'))
    temporary((root) => {
      const path = join(root, '000000000001.json')
      writeFileSync(path, first)
      preflightDirectory(root, lane.recordBytes)
      writeFileSync(join(root, '000000000002.json'), first)
      assert.throws(() => verify(m, root, { maxRecords: 1, maxTotalBytes: 1000000 }), /count_limit/)
    })
    temporary((root) => {
      const path = join(root, '000000000001.json')
      writeFileSync(path, first)
      preflightDirectory(root, lane.recordBytes)
      writeFileSync(path, 'x'.repeat(lane.recordBytes + 1))
      assert.throws(() => verify(m, root, { maxRecords: 1, maxTotalBytes: 1000000 }), /oversize/)
    })
    temporary((root) => {
      writeFileSync(join(root, '000000000001.json'), first)
      assert.throws(
        () => verify(m, root, { maxRecords: 1, maxTotalBytes: first.length - 1 }),
        /total_limit/,
      )
      const verified = verify(m, root, { maxRecords: 1, maxTotalBytes: first.length })
      assert.equal(verified.count, 1)
      assert.equal(verified.totalBytes, first.length)
    })
  }
})

test('failed exclusive second open preserves the other writer and cleans only the owned first file', () =>
  temporary((root) => {
    const paths = { pins: join(root, 'pins.json'), audit: join(root, 'audit.json') }
    assert.throws(
      () =>
        writeArtifacts(files, paths, 10 ** 10, (fd, bytes) => {
          writeFileSync(fd, bytes)
          writeFileSync(paths.audit, 'other_writer', { flag: 'wx' })
        }),
      /EEXIST/,
    )
    assert.equal(existsSync(paths.pins), false)
    assert.equal(readFileSync(paths.audit, 'utf8'), 'other_writer')
  }))

test('rollback preserves replaced owned inode and cleans the other owned output', () => {
  temporary((root) => {
    const paths = { pins: join(root, 'pins.json'), audit: join(root, 'audit.json') }
    let writes = 0
    assert.throws(
      () =>
        writeArtifacts(files, paths, 10 ** 10, (fd, bytes) => {
          writeFileSync(fd, bytes.slice(0, 9))
          writes++
          if (writes === 2) {
            renameSync(paths.pins, join(root, 'original-owned'))
            writeFileSync(paths.pins, 'replacement_writer', { flag: 'wx' })
            throw Error('injected_replacement_failure')
          }
        }),
      /injected_replacement_failure/,
    )
    assert.equal(readFileSync(paths.pins, 'utf8'), 'replacement_writer')
    assert.equal(existsSync(paths.audit), false)
  })
})
test('check uses bounded actual reads and rejects concurrent growth/replacement without writes', () => {
  for (const attack of ['growth', 'replacement'])
    temporary((root) => {
      const paths = { pins: join(root, 'pins.json'), audit: join(root, 'audit.json') }
      writeArtifacts(files, paths, 10 ** 10)
      checkArtifacts(files, paths)
      let attacked = false,
        readBytes = 0
      assert.throws(
        () =>
          checkArtifacts(files, paths, {
            readSync(fd, buffer, offset, length, position) {
              assert.equal(buffer.length, LIMITS.artifactBytes + 1)
              if (!attacked) {
                attacked = true
                if (attack === 'growth')
                  writeFileSync(paths.pins, 'x'.repeat(LIMITS.artifactBytes + 100))
                else {
                  renameSync(paths.pins, join(root, 'original'))
                  writeFileSync(paths.pins, 'replacement_writer', { flag: 'wx' })
                }
              }
              const n = readSync(fd, buffer, offset, length, position)
              readBytes += n
              return n
            },
          }),
        attack === 'growth' ? /oversize/ : /changed_during_read/,
      )
      assert.ok(readBytes <= LIMITS.artifactBytes + 1)
      assert.equal(readFileSync(paths.audit, 'utf8'), files.audit)
      if (attack === 'replacement')
        assert.equal(readFileSync(paths.pins, 'utf8'), 'replacement_writer')
    })
})
