import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { makeSelection, readSources, save, verify } from './scrvusd-holder-selection-link.mjs'
import { OUT as SEED_OUT } from './scrvusd-index-holder-seed.mjs'

const sources = readSources()

test('real sealed plan and index seed produce exact certificate', () => {
  const selection = makeSelection({ sources })
  assert.equal(selection.holder, sources.seed.candidates[0])
  assert.equal(selection.plan.logicalSha256, sources.plan.sha256)
  assert.equal(selection.seed.logicalSha256, sources.seed.sha256)
})

test('rejects wrong candidate, quantity, and backdated or future capture', () => {
  const wrongHolder = {
    ...sources,
    plan: { ...sources.plan, holder: '0x0000000000000000000000000000000000000001' },
  }
  assert.throws(() => makeSelection({ sources: wrongHolder }))
  const wrongQuantity = { ...sources, plan: { ...sources.plan, rawCrvUsd: '1' } }
  assert.throws(() => makeSelection({ sources: wrongQuantity }))
  assert.throws(() =>
    makeSelection({
      sources,
      capturedUtc: new Date(Date.parse(sources.plan.createdUtc) - 1).toISOString(),
    }),
  )
  assert.throws(() =>
    makeSelection({ sources, capturedUtc: new Date(Date.now() + 60_000).toISOString() }),
  )
})

test('rejects prior eligible quote and seed captured after plan', () => {
  const quote = {
    checkpoint: { block: { timestamp: Math.ceil(Date.parse(sources.plan.createdUtc) / 1000) } },
  }
  assert.throws(() => makeSelection({ sources: { ...sources, checkpoints: [quote] } }))
  assert.throws(() =>
    makeSelection({
      sources: {
        ...sources,
        seed: { ...sources.seed, captureEndMs: Date.parse(sources.plan.createdUtc) + 1 },
      },
    }),
  )
})

test('saved certificate is immutable and physical tamper fails replay', () => {
  const out = mkdtempSync(join(tmpdir(), 'holder-link-'))
  try {
    const selection = makeSelection({ sources })
    const stat = () => ({ bavail: 2_000_000_000, bsize: 1 })
    save({ out, selection, sources, stat })
    assert.equal(verify({ out, sources }).status, 'verified')
    assert.throws(() => save({ out, selection, sources, stat }))
    const file = join(out, 'selection.json')
    const bytes = readFileSync(file, 'utf8')
    writeFileSync(
      file,
      bytes.replace(selection.holder, '0x0000000000000000000000000000000000000001'),
    )
    assert.throws(() => verify({ out, sources }))
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('plan and seed physical bytes are bound', () => {
  const selection = makeSelection({ sources })
  assert.notEqual(
    makeSelection({ sources: { ...sources, planBytes: Buffer.from('{}') } }).sha256,
    selection.sha256,
  )
  assert.notEqual(
    makeSelection({ sources: { ...sources, seedBytes: Buffer.from('{}') } }).sha256,
    selection.sha256,
  )
})

test('replay reads the sealed seed filename even after another valid matching seed appears', () => {
  const root = mkdtempSync(join(tmpdir(), 'holder-link-replay-'))
  const seedOut = join(root, 'seeds')
  const out = join(root, 'selection')
  try {
    mkdirSync(seedOut)
    copyFileSync(join(SEED_OUT, sources.seedFilename), join(seedOut, sources.seedFilename))
    const selection = makeSelection({ sources })
    save({ out, selection, sources, stat: () => ({ bavail: 2_000_000_000, bsize: 1 }) })
    const { sha256: _oldSha, ...body } = sources.seed
    const duplicate = { ...body, captureEndMs: body.captureEndMs + 1 }
    duplicate.sha256 = createHash('sha256').update(JSON.stringify(duplicate)).digest('hex')
    const duplicateName = `${String(duplicate.anchor.number).padStart(12, '0')}-${duplicate.anchor.hash.slice(2)}-${duplicate.captureEndMs}.json`
    writeFileSync(join(seedOut, duplicateName), `${JSON.stringify(duplicate)}\n`)
    assert.throws(() => readSources({ seedOut }))
    assert.equal(verify({ out, sourceOptions: { seedOut } }).status, 'verified')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI verify fails closed when no certificate is present', () => {
  const root = mkdtempSync(join(tmpdir(), 'holder-link-empty-'))
  try {
    const script = fileURLToPath(new URL('./scrvusd-holder-selection-link.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [script, '--verify'], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.equal(result.status, 1)
    assert.equal(result.stderr.trim(), 'holder_selection_link_failed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
