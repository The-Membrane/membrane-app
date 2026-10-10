import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readBoundedReceiptFile } from '../../scripts/lib/boundedLocalReceiptFile.mjs'
import {
  createProtectedResearchWriter,
  encodeSubjectSnapshot,
  decodeSubjectSnapshot,
  parseArgs,
  run,
} from '../../scripts/research/morpho-native-event-cash-analysis.mjs'
import { readPinnedMorphoNativeEventCashDataset } from '../../lib/carry/morphoNativeEventCashAdapter.server'

const fixture = vi.hoisted(() => ({
  now: 0,
  manifestPath: 'controlled-writer-manifest.json',
  manifestText: '{"scope":"controlled_unsigned_writer_fixture"}\n',
  sourceText: '// controlled unsigned source copy\n',
  dataset: {
    knowledgeCutoffUtc: '2026-10-09T12:00:00.000Z',
    inputPins: [{ path: 'controlled-original', bytes: 1 }],
    manifest: { scope: 'controlled_unsigned' },
    originalEventEnvelopeClockRange: ['retained', 'retained'],
    excludedCashSubjects: [],
  },
  analysis: {
    informationMode: 'retrospective_training',
    counts: { selectorSubjects: 1, nativeDepositEvents: 0 },
    subjects: [
      {
        identity: { routeKey: 'controlled subject', assetDecimals: 6 },
        metricRegime: 'native_cash_fixture',
        input: {
          histories: [
            {
              points: [
                { index: 0, cashRaw: '1000' },
                { index: 1, cashRaw: '900' },
              ],
            },
          ],
          events: [],
        },
        selection: {
          signedNET: ['-100'],
          physicalStockRisk: { censored: true, retainedReason: 'controlled' },
        },
        chronologicalFolds: [{ originIndex: 0, observedNetRaw: '-100', eligible: true }],
        summary: { scoredFolds: 1, negativePhysicalStockRisks: 1 },
      },
    ],
  },
}))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    openSync: vi.fn(real.openSync),
    writeSync: vi.fn(real.writeSync),
    closeSync: vi.fn(real.closeSync),
    fsyncSync: vi.fn(real.fsyncSync),
    fstatSync: vi.fn(real.fstatSync),
    lstatSync: vi.fn(real.lstatSync),
    mkdirSync: vi.fn(real.mkdirSync),
    statfsSync: vi.fn(),
  }
})
vi.mock('node:perf_hooks', () => ({ performance: { now: vi.fn(() => fixture.now) } }))
vi.mock('../../scripts/lib/boundedLocalReceiptFile.mjs', () => ({
  readBoundedReceiptFile: vi.fn(),
}))
vi.mock('../../lib/carry/morphoNativeEventCashAdapter.server.ts', async () => {
  const { createHash } = await import('node:crypto')
  return {
    MORPHO_EVENT_CASH_MANIFEST_PATH: fixture.manifestPath,
    MORPHO_EVENT_CASH_MANIFEST_SHA: createHash('sha256').update(fixture.manifestText).digest('hex'),
    readPinnedMorphoNativeEventCashDataset: vi.fn(() => fixture.dataset),
    analyzeMorphoNativeEventCashDataset: vi.fn(() => fixture.analysis),
  }
})

const ROOT = resolve(import.meta.dirname, '../..')
const PARENT = resolve(ROOT, 'data/research/venue-signals')
const MB = 1024 * 1024
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
let real: typeof import('node:fs'), out: string, scratch: string
let importDirectoryCalls = -1,
  importDatasetCalls = -1
function free(bytes: number) {
  vi.mocked(fs.statfsSync).mockReturnValue({ bavail: BigInt(bytes), bsize: 1n } as ReturnType<
    typeof fs.statfsSync
  >)
}
// A one-byte backing buffer with a declared length exercises rejection/charging without large allocation.
function declaredBytes(length: number): Buffer {
  return Object.defineProperty(Buffer.from('x'), 'length', { value: length })
}
function retained(path: string) {
  const text = real.readFileSync(path, 'utf8'),
    record = JSON.parse(text)
  const { sha256, ...body } = record
  expect(sha256).toBe(hash(JSON.stringify(body)))
  expect(text).toBe(JSON.stringify(record) + '\n')
  return record
}
beforeAll(async () => {
  importDirectoryCalls = vi.mocked(fs.mkdirSync).mock.calls.length
  importDatasetCalls = vi.mocked(readPinnedMorphoNativeEventCashDataset).mock.calls.length
  real = await vi.importActual<typeof import('node:fs')>('node:fs')
})
beforeEach(() => {
  fixture.now = 0
  vi.mocked(performance.now)
    .mockReset()
    .mockImplementation(() => fixture.now)
  for (const name of [
    'openSync',
    'writeSync',
    'closeSync',
    'fsyncSync',
    'fstatSync',
    'lstatSync',
    'mkdirSync',
  ] as const)
    vi.mocked(fs[name])
      .mockReset()
      .mockImplementation(real[name] as never)
  vi.mocked(fs.statfsSync).mockReset()
  free(2 * 1024 * MB)
  vi.mocked(readPinnedMorphoNativeEventCashDataset).mockClear()
  out = resolve(PARENT, 'morpho-native-event-cash-analysis-writer-test-' + randomUUID())
  scratch = real.mkdtempSync(join(tmpdir(), 'morpho-event-writer-test-'))
  vi.mocked(readBoundedReceiptFile)
    .mockReset()
    .mockImplementation((path: string, budget: { totalBytes: number }) => {
      const text =
        path === resolve(ROOT, fixture.manifestPath)
          ? fixture.manifestText
          : path.startsWith(out + '/')
            ? real.readFileSync(path, 'utf8')
            : fixture.sourceText
      budget.totalBytes += Buffer.byteLength(text)
      return text
    })
})
afterEach(() => {
  vi.useRealTimers()
  real.rmSync(out, { recursive: true, force: true })
  real.rmSync(scratch, { recursive: true, force: true })
})

describe('explicit offline event-cash writer', () => {
  it('does not create a directory or acquire a dataset when imported or parsing arguments', () => {
    expect(importDirectoryCalls).toBe(0)
    expect(importDatasetCalls).toBe(0)
    expect(fs.mkdirSync).not.toHaveBeenCalled()
    expect(readPinnedMorphoNativeEventCashDataset).not.toHaveBeenCalled()
    expect(parseArgs([])).toMatch(new RegExp('^' + PARENT + '/morpho-native-event-cash-analysis-'))
    expect(parseArgs(['--out', out])).toBe(out)
    expect(fs.mkdirSync).not.toHaveBeenCalled()
  })
  it.each([
    ['--out'],
    ['--out', '/private/tmp/morpho-native-event-cash-analysis-escape'],
    ['--out', 'data/research/venue-signals/unrelated-output'],
  ])('rejects argument or output-parent escape %j', (...argv) => {
    expect(() => parseArgs(argv)).toThrow(/event_cash_cli_/)
    expect(fs.mkdirSync).not.toHaveBeenCalled()
  })
  it('rejects a direct writer outside the fixed parent before touching disk', () => {
    expect(() => createProtectedResearchWriter(resolve(scratch, 'escape'), 0)).toThrow(
      'event_cash_output_parent',
    )
    expect(fs.mkdirSync).not.toHaveBeenCalled()
  })
  it('rejects a symbolic output parent', () => {
    vi.mocked(fs.lstatSync).mockReturnValueOnce({
      isDirectory: () => true,
      isSymbolicLink: () => true,
    } as ReturnType<typeof fs.lstatSync>)
    expect(() => createProtectedResearchWriter(out, 0)).toThrow('event_cash_output_parent_identity')
    expect(fs.mkdirSync).not.toHaveBeenCalled()
  })
  it('retains private files only after fsync and exact readback, and refuses replacement', () => {
    const writer = createProtectedResearchWriter(out, 0),
      bytes = Buffer.from('retained\n')
    const ref = writer.write('receipt.json', bytes)
    expect(real.statSync(out).mode & 0o777).toBe(0o700)
    expect(real.statSync(resolve(out, ref.file)).mode & 0o777).toBe(0o600)
    expect(real.readFileSync(resolve(out, ref.file))).toEqual(bytes)
    expect(ref).toMatchObject({ bytes: bytes.length, sha256: hash(bytes) })
    expect(writer.references).toEqual([ref])
    expect(Math.max(...vi.mocked(fs.fsyncSync).mock.invocationCallOrder)).toBeLessThan(
      vi.mocked(readBoundedReceiptFile).mock.invocationCallOrder[0],
    )
    const flags = vi
      .mocked(fs.openSync)
      .mock.calls.find(([path]) => path === resolve(out, ref.file))![1] as number
    expect(flags & fs.constants.O_EXCL).toBe(fs.constants.O_EXCL)
    expect(flags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW)
    expect(() => writer.write(ref.file, Buffer.from('replace'))).toThrow()
    expect(writer.attemptedBytes()).toBe(bytes.length)
    expect(real.readFileSync(resolve(out, ref.file))).toEqual(bytes)
    expect(() => createProtectedResearchWriter(out, 0)).toThrow()
  })
  it('refuses an existing symlink without changing its target or charging a new file', () => {
    const writer = createProtectedResearchWriter(out, 0),
      victim = resolve(scratch, 'victim')
    real.writeFileSync(victim, 'original')
    real.symlinkSync(victim, resolve(out, 'receipt.json'))
    expect(() => writer.write('receipt.json', Buffer.from('overwrite'))).toThrow()
    expect(real.readFileSync(victim, 'utf8')).toBe('original')
    expect(writer.attemptedBytes()).toBe(0)
    expect(writer.references).toHaveLength(0)
  })
  it.each(['hardlink', 'replacement', 'public-mode'] as const)(
    'rejects post-fsync %s identity tampering',
    (kind) => {
      const writer = createProtectedResearchWriter(out, 0),
        path = resolve(out, 'receipt.json')
      let changed = false
      vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
        real.fsyncSync(fd)
        if (!changed && real.fstatSync(fd).isFile()) {
          changed = true
          if (kind === 'hardlink') real.linkSync(path, resolve(scratch, 'alias'))
          if (kind === 'replacement') {
            real.renameSync(path, resolve(out, 'original.json'))
            real.writeFileSync(path, 'abc', { mode: 0o600 })
          }
          if (kind === 'public-mode') real.chmodSync(path, 0o644)
        }
      })
      expect(() => writer.write('receipt.json', Buffer.from('abc'))).toThrow(
        'event_cash_output_postfsync_identity',
      )
      expect(writer.attemptedBytes()).toBe(3)
      expect(writer.references).toHaveLength(0)
    },
  )
  it('rejects same-length changed readback without publishing a retained reference', () => {
    const writer = createProtectedResearchWriter(out, 0)
    vi.mocked(readBoundedReceiptFile).mockReturnValueOnce('xyz')
    expect(() => writer.write('receipt.json', Buffer.from('abc'))).toThrow(
      'event_cash_output_readback',
    )
    expect(writer.attemptedBytes()).toBe(3)
    expect(writer.references).toHaveLength(0)
  })
  it('rejects escaped names and non-buffer payloads before creating a file', () => {
    const writer = createProtectedResearchWriter(out, 0)
    expect(() => writer.write('../escape', Buffer.from('x'))).toThrow(
      'event_cash_output_bytes_limit',
    )
    expect(() => writer.write('receipt.json', 'x')).toThrow('event_cash_output_bytes_limit')
    expect(writer.attemptedBytes()).toBe(0)
    expect(real.readdirSync(out)).toEqual([])
  })
  it.each([
    { name: 'oversize.json', length: 8 * MB + 1, terminal: false },
    { name: 'terminal.json', length: 64 * 1024 + 1, terminal: true },
  ])(
    'enforces the byte cap for $name without allocating that payload',
    ({ name, length, terminal }) => {
      const writer = createProtectedResearchWriter(out, 0)
      expect(() => writer.write(name, declaredBytes(length), terminal)).toThrow(
        'event_cash_output_bytes_limit',
      )
      expect(writer.attemptedBytes()).toBe(0)
      expect(real.readdirSync(out)).toEqual([])
    },
  )
  it('rejects insufficient preflight space before creating an output directory', () => {
    free(287 * MB)
    expect(() => createProtectedResearchWriter(out, 0)).toThrow('event_cash_disk_guard')
    expect(real.existsSync(out)).toBe(false)
  })
  it('rechecks disk space before writing after free space falls below the reserve', () => {
    const writer = createProtectedResearchWriter(out, 0)
    free(255 * MB)
    expect(() => writer.write('receipt.json', Buffer.from('abc'))).toThrow('event_cash_disk_guard')
    expect(writer.attemptedBytes()).toBe(0)
    expect(real.readdirSync(out)).toEqual([])
  })
  it.each(['before-write', 'after-readback'] as const)(
    'refuses publication when deadline expires %s',
    (boundary) => {
      const writer = createProtectedResearchWriter(out, 0)
      if (boundary === 'before-write') fixture.now = 120001
      else
        vi.mocked(readBoundedReceiptFile).mockImplementationOnce(() => {
          fixture.now = 120001
          return 'abc'
        })
      expect(() => writer.write('receipt.json', Buffer.from('abc'))).toThrow(
        'event_cash_offline_deadline',
      )
      expect(writer.attemptedBytes()).toBe(boundary === 'before-write' ? 0 : 3)
      expect(writer.references).toHaveLength(0)
    },
  )
  it('charges failed fsync attempts and preserves the cohort allowance for a terminal', () => {
    const writer = createProtectedResearchWriter(out, 0)
    vi.mocked(fs.writeSync).mockReturnValue(8 * MB)
    vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
      if (real.fstatSync(fd).isFile()) throw Error('controlled fsync failure')
      real.fsyncSync(fd)
    })
    for (let index = 0; index < 3; index++)
      expect(() => writer.write('attempt-' + index + '.json', declaredBytes(8 * MB))).toThrow(
        'controlled fsync failure',
      )
    expect(writer.attemptedBytes()).toBe(24 * MB)
    expect(writer.references).toHaveLength(0)
    expect(() => writer.write('attempt-3.json', declaredBytes(8 * MB))).toThrow(
      'event_cash_output_bytes_limit',
    )
    expect(real.existsSync(resolve(out, 'attempt-3.json'))).toBe(false)
    expect(writer.attemptedBytes()).toBe(24 * MB)
  })
  it('writes compact sealed records with every controlled field and clocks completion after terminal fsync', () => {
    const before = '2026-10-09T12:00:00.000Z',
      after = '2026-10-09T12:00:05.000Z'
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(before)
    let terminalFsynced = false
    vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
      real.fsyncSync(fd)
      if (real.existsSync(resolve(out, 'terminal.json')) && real.fstatSync(fd).isFile()) {
        terminalFsynced = true
        vi.setSystemTime(after)
      }
    })
    const result = run(['--out', out])
    expect(result.complete).toBe(true)
    const subjectPath = resolve(out, 'subject-000.json')
    const storedSubject = retained(subjectPath),
      subjectBytes = decodeSubjectSnapshot(real.readFileSync(subjectPath))
    const subject = JSON.parse(subjectBytes.toString('utf8'))
    expect(subject.input).toEqual(fixture.analysis.subjects[0].input)
    expect(subject.output).toEqual({
      selection: fixture.analysis.subjects[0].selection,
      chronologicalFolds: fixture.analysis.subjects[0].chronologicalFolds,
      summary: fixture.analysis.subjects[0].summary,
    })
    const report = retained(resolve(out, 'analysis.json')),
      terminal = retained(resolve(out, 'terminal.json'))
    expect(report.counts).toEqual(fixture.analysis.counts)
    expect(report.originalInputs).toEqual(fixture.dataset.inputPins)
    expect(report.subjectSummaries[0].snapshotStorage).toEqual({
      wrapperSchema: storedSubject.schema,
      encoding: 'gzip-base64',
      fileBytes: real.statSync(subjectPath).size,
      fileSha256: hash(real.readFileSync(subjectPath)),
      decodedBytes: subjectBytes.length,
      decodedSha256: hash(subjectBytes),
      compressedBytes: storedSubject.compressedBytes,
      compressedSha256: storedSubject.compressedSha256,
    })
    expect(report.subjectSnapshotStorage).toMatchObject({
      decodedByteTotal: subjectBytes.length,
      compressedByteTotal: storedSubject.compressedBytes,
      persistedWrapperByteTotal: real.statSync(subjectPath).size,
      decodedPerSubjectByteLimit: 8 * MB,
      persistedCohortByteLimit: 32 * MB,
      cohortBudgetBasis: 'persisted_encoded_wrapper_file_bytes',
      lossless: true,
      preservesOriginalSealedJSONBytes: true,
    })
    expect(report.newRPC).toBe(0)
    expect(terminalFsynced).toBe(true)
    expect(terminal.qualificationAtUtc).toBe(before)
    expect(terminal.qualificationClockBoundary).toBe('before_terminal_file_and_directory_fsync')
    expect(result.completedAtUtc).toBe(after)
    expect(result.completionClockBoundary).toBe(
      'after_terminal_fsync_readback_identity_and_deadline',
    )
    expect(terminal.references).toHaveLength(10)
    for (const ref of terminal.references) {
      const bytes = real.readFileSync(resolve(out, ref.file))
      expect(ref).toMatchObject({ bytes: bytes.length, sha256: hash(bytes) })
    }
    expect(terminal.references.some((ref: { file: string }) => ref.file === 'terminal.json')).toBe(
      false,
    )
  })
  it.each([
    {
      message: 'fsync failed: Authorization Bearer controlled-private-marker',
      reason: 'event_cash_unknown_failure',
    },
    { message: 'event_cash_output_readback', reason: 'event_cash_output_readback' },
  ])(
    'returns sanitized partial accounting for $reason without deleting attempted files',
    ({ message, reason }) => {
      vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
        if (real.fstatSync(fd).isFile()) throw Error(message)
        real.fsyncSync(fd)
      })
      const result = run(['--out', out])
      expect(result).toMatchObject({
        complete: false,
        reason,
        attemptedWriteBytes: Buffer.byteLength(fixture.manifestText),
        retainedFiles: 0,
        newRPC: 0,
      })
      expect(JSON.stringify(result)).not.toContain('controlled-private-marker')
      expect(real.readFileSync(resolve(out, 'input-manifest.json'), 'utf8')).toBe(
        fixture.manifestText,
      )
      expect(real.existsSync(resolve(out, 'terminal.json'))).toBe(false)
    },
  )
})

function seal(body: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify({ ...body, sha256: hash(JSON.stringify(body)) }) + '\n')
}
function originalSubject(): Buffer {
  return seal({
    schema: 'morpho_native_event_cash_subject_snapshot_v1',
    identity: fixture.analysis.subjects[0].identity,
    input: fixture.analysis.subjects[0].input,
    output: {
      selection: fixture.analysis.subjects[0].selection,
      chronologicalFolds: fixture.analysis.subjects[0].chronologicalFolds,
      summary: fixture.analysis.subjects[0].summary,
    },
    originalAuthority: false,
    authenticated: false,
    forecastValidated: false,
    holderExecutableExit: false,
    preservedExtraFields: { nullable: null, negativeNET: '-100', zero: 0, unicode: 'GHO ↔ bone' },
  })
}
function changedWrapper(edit: (body: Record<string, unknown>) => void): Buffer {
  const record = JSON.parse(encodeSubjectSnapshot(originalSubject()).toString('utf8'))
  const { sha256, ...body } = record
  void sha256
  edit(body)
  return seal(body)
}

describe('lossless gzip-base64 subject storage', () => {
  it('preserves every original sealed byte, separates all three hashes and produces deterministic zero-mtime gzip', () => {
    const original = originalSubject(),
      first = encodeSubjectSnapshot(original),
      second = encodeSubjectSnapshot(original)
    expect(first).toEqual(second)
    expect(decodeSubjectSnapshot(first)).toEqual(original)
    const stored = JSON.parse(first.toString('utf8')),
      compressed = Buffer.from(stored.base64, 'base64')
    const { sha256, ...body } = stored
    expect(sha256).toBe(hash(JSON.stringify(body)))
    expect(stored).toMatchObject({
      encoding: 'gzip-base64',
      decodedBytes: original.length,
      decodedSha256: hash(original),
      compressedBytes: compressed.length,
      compressedSha256: hash(compressed),
    })
    expect(compressed.readUInt32LE(4)).toBe(0)
    expect(new Set([hash(first), hash(original), hash(compressed)]).size).toBe(3)
    expect(JSON.parse(decodeSubjectSnapshot(first).toString('utf8')).preservedExtraFields).toEqual({
      nullable: null,
      negativeNET: '-100',
      zero: 0,
      unicode: 'GHO ↔ bone',
    })
  })
  it('rejects a changed wrapper seal and duplicate JSON keys', () => {
    const encoded = encodeSubjectSnapshot(originalSubject()),
      record = JSON.parse(encoded.toString('utf8'))
    record.sha256 = '0'.repeat(64)
    expect(() => decodeSubjectSnapshot(Buffer.from(JSON.stringify(record) + '\n'))).toThrow(
      'event_cash_subject_snapshot_wrapper',
    )
    const duplicate = encoded
      .toString('utf8')
      .replace('"encoding":"gzip-base64"', '"encoding":"gzip-base64","encoding":"gzip-base64"')
    expect(() => decodeSubjectSnapshot(Buffer.from(duplicate))).toThrow(
      'event_cash_subject_snapshot_wrapper',
    )
  })
  it.each(['schema', 'encoding', 'extra-field'] as const)(
    'rejects resealed unsupported %s metadata',
    (field) => {
      const bytes = changedWrapper((body) => {
        if (field === 'extra-field') body.undeclaredStoragePolicy = true
        else body[field] = 'unreviewed'
      })
      expect(() => decodeSubjectSnapshot(bytes)).toThrow('event_cash_subject_snapshot_metadata')
    },
  )
  it.each(['whitespace', 'illegal-character', 'missing-character'] as const)(
    'rejects permissive base64 %s',
    (kind) => {
      const bytes = changedWrapper((body) => {
        const base64 = body.base64 as string
        body.base64 =
          kind === 'whitespace'
            ? ' ' + base64
            : kind === 'illegal-character'
              ? '*' + base64.slice(1)
              : base64.slice(0, -1)
      })
      expect(() => decodeSubjectSnapshot(bytes)).toThrow('event_cash_subject_snapshot_base64')
    },
  )
  it.each(['compressedSha256', 'decodedSha256'] as const)(
    'rejects resealed mismatched %s',
    (field) => {
      const bytes = changedWrapper((body) => {
        body[field] = '0'.repeat(64)
      })
      expect(() => decodeSubjectSnapshot(bytes)).toThrow(
        /event_cash_subject_snapshot_(compressed|decoded)_pin/,
      )
    },
  )
  it.each(['compressedBytes', 'decodedBytes'] as const)(
    'rejects resealed mismatched %s lengths',
    (field) => {
      const bytes = changedWrapper((body) => {
        body[field] = Number(body[field]) + 1
      })
      expect(() => decodeSubjectSnapshot(bytes)).toThrow(/event_cash_subject_snapshot_/)
    },
  )
  it('retains the existing decoded file cap before compression or decompression', () => {
    expect(() => encodeSubjectSnapshot(declaredBytes(8 * MB + 1))).toThrow(
      'event_cash_subject_snapshot_decoded',
    )
    const oversized = changedWrapper((body) => {
      body.decodedBytes = 8 * MB + 1
    })
    expect(() => decodeSubjectSnapshot(oversized)).toThrow('event_cash_subject_snapshot_metadata')
  })
  it('bounds gunzip by the declared decoded size using a small expansion fixture', () => {
    const compressed = gzipSync(Buffer.alloc(4096, 0x78), { level: 9 })
    const bytes = changedWrapper((body) => {
      body.decodedBytes = 1
      body.decodedSha256 = hash(Buffer.from('x'))
      body.compressedBytes = compressed.length
      body.compressedSha256 = hash(compressed)
      body.base64 = compressed.toString('base64')
    })
    expect(() => decodeSubjectSnapshot(bytes)).toThrow('event_cash_subject_snapshot_gzip')
  })
  it('rejects a resealed nonzero gzip mtime without confusing it with original acquisition clocks', () => {
    const bytes = changedWrapper((body) => {
      const compressed = Buffer.from(body.base64 as string, 'base64')
      compressed[4] = 1
      body.compressedSha256 = hash(compressed)
      body.base64 = compressed.toString('base64')
    })
    expect(() => decodeSubjectSnapshot(bytes)).toThrow('event_cash_subject_snapshot_gzip_header')
  })
  it.each(['empty-member', 'zero-padding', 'OS', 'XFL'] as const)(
    'rejects repinned noncanonical gzip %s with identical decoded bytes',
    (kind) => {
      const wrapper = changedWrapper((body) => {
        let compressed = Buffer.from(body.base64 as string, 'base64')
        if (kind === 'empty-member')
          compressed = Buffer.concat([compressed, gzipSync(Buffer.alloc(0), { level: 9 })])
        if (kind === 'zero-padding') compressed = Buffer.concat([compressed, Buffer.alloc(1)])
        if (kind === 'OS') compressed[9] ^= 1
        if (kind === 'XFL') compressed[8] ^= 1
        body.compressedBytes = compressed.length
        body.compressedSha256 = hash(compressed)
        body.base64 = compressed.toString('base64')
      })
      expect(() => decodeSubjectSnapshot(wrapper)).toThrow(
        'event_cash_subject_snapshot_gzip_canonical',
      )
    },
  )
  it('rejects a stale original body seal even inside a correctly pinned wrapper', () => {
    const changed = JSON.parse(originalSubject().toString('utf8'))
    changed.authenticated = true
    const invalidOriginal = Buffer.from(JSON.stringify(changed) + '\n')
    expect(() => encodeSubjectSnapshot(invalidOriginal)).toThrow(
      'event_cash_subject_snapshot_decoded',
    )
    const compressed = gzipSync(invalidOriginal, { level: 9 })
    const wrapper = changedWrapper((body) => {
      body.decodedBytes = invalidOriginal.length
      body.decodedSha256 = hash(invalidOriginal)
      body.compressedBytes = compressed.length
      body.compressedSha256 = hash(compressed)
      body.base64 = compressed.toString('base64')
    })
    expect(() => decodeSubjectSnapshot(wrapper)).toThrow('event_cash_subject_snapshot_decoded')
  })
})
