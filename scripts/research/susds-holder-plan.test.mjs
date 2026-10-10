import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { keccak256 } from 'viem'
import { sourceIdentity } from './susds-finalized-checkpoint.mjs'
import { FIXED_Q_RAW } from './susds-holder-seed.mjs'
import {
  makePlan,
  readPlan,
  readSources,
  savePlan,
  validatePlan,
  verify,
} from './susds-holder-plan.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const seal = (value) => ({ ...value, sha256: sha(JSON.stringify(value)) })
const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`
const blockHash = `0x${'a'.repeat(64)}`
const implementation = addr(999)
const identity = sourceIdentity([
  {
    name: 'sUSDS',
    enabled: true,
    address: '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd',
    underlying: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
    decimals: 18,
  },
])
const stat = () => ({ bavail: 2_000_000_000, bsize: 1 })

function fixture(noEligible = false) {
  const root = mkdtempSync(join(tmpdir(), 'susds-holder-plan-'))
  const checkpointOut = join(root, 'checkpoints')
  const seedOut = join(root, 'seeds')
  const planOut = join(root, 'plan')
  mkdirSync(checkpointOut)
  mkdirSync(seedOut)
  const now = Date.now()
  const block = { number: 100, hash: blockHash, timestamp: Math.floor((now - 120_000) / 1000) }
  const checkpoint = seal({
    study: 'susds-finalized-vault-checkpoint-v1',
    source: identity,
    captureStartUtc: new Date(now - 81_000).toISOString(),
    captureEndUtc: new Date(now - 80_000).toISOString(),
    block,
    pinMode: 'hash',
    pinCaveat: null,
    contract: {
      vaultCodeHash: keccak256('0x60016002'),
      implementationSlotWord: `0x${'0'.repeat(24)}${implementation.slice(2)}`,
      implementation,
      implementationCodeHash: keccak256('0x60036004'),
    },
    state: {
      asset: identity.asset,
      decimals: 18,
      totalAssetsRaw: '100',
      totalSupplyRaw: '100',
      assetsPerShareRaw: '100',
    },
    caveat:
      'One finalized-block source and state observation; code hashes do not establish historical implementation parity or holder exit feasibility.',
  })
  const checkpointFilename = `${String(block.number).padStart(12, '0')}-${block.hash.slice(2)}.json`
  const checkpointBytes = `${JSON.stringify(checkpoint)}\n`
  writeFileSync(join(checkpointOut, checkpointFilename), checkpointBytes)
  const rawBody = JSON.stringify({
    items: Array.from({ length: 50 }, (_, i) => ({
      address: { hash: addr(i + 10) },
      value: String(50 - i),
    })),
    next_page_params: { items_count: 50, value: '1' },
  })
  const raw = JSON.parse(rawBody)
  const pageRows = raw.items.map((item, i) => ({
    listedRank: i + 1,
    address: item.address.hash,
    listedSharesRaw: item.value,
  }))
  const results = pageRows.map((row) => ({
    ...row,
    code: '0x',
    codeHash: null,
    balanceSharesRaw: String(50n * FIXED_Q_RAW - BigInt(row.listedRank)),
    maxWithdrawAssetsRaw: noEligible ? String(FIXED_Q_RAW - 1n) : FIXED_Q_RAW.toString(),
    previewSharesRaw: FIXED_Q_RAW.toString(),
    readError: null,
    status: noEligible ? 'dust_or_empty' : 'eligible',
  }))
  const seed = seal({
    study: 'susds-holder-seed-v1',
    kind: 'blockscout-first-page',
    source: identity,
    checkpoint: {
      filename: checkpointFilename,
      logicalSha256: checkpoint.sha256,
      physicalSha256: sha(checkpointBytes),
      block,
      vaultCodeHash: checkpoint.contract.vaultCodeHash,
      implementation,
      implementationCodeHash: checkpoint.contract.implementationCodeHash,
    },
    anchor: block,
    page: {
      url: `https://eth.blockscout.com/api/v2/tokens/${identity.vault}/holders`,
      httpStatus: 200,
      fetchedAtMs: now - 58_000,
      nextPageParamsPresent: true,
      rawItems: raw.items,
      rawNextPageParams: raw.next_page_params,
      rawBody,
      rawBodySha256: sha(rawBody),
      rows: pageRows,
    },
    captureStartMs: now - 60_000,
    captureEndMs: now - 50_000,
    vaultCodeHash: checkpoint.contract.vaultCodeHash,
    asset: identity.asset,
    results,
    status: noEligible ? 'no_eligible' : 'sampled',
    candidates: noEligible ? [] : pageRows.map((row) => row.address),
    caveat:
      'Blockscout first-page discovery sample, not a holder census, key control, withdrawal intent, or executable outcome. Listed order and values are untrusted offchain metadata; eligibility uses one finalized Ethereum block and one RPC host.',
  })
  const seedFilename = `${String(block.number).padStart(12, '0')}-${block.hash.slice(2)}-${seed.captureEndMs}.json`
  writeFileSync(join(seedOut, seedFilename), `${JSON.stringify(seed)}\n`)
  const sourceOptions = { seedOut, checkpointOut, identity }
  return {
    root,
    planOut,
    sourceOptions,
    createdUtc: new Date(now - 40_000).toISOString(),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('plan freezes exact seed, source checkpoint, holder and fixed q before future observation', () => {
  const x = fixture()
  try {
    const sources = readSources(x.sourceOptions)
    const plan = makePlan({ sources, createdUtc: x.createdUtc })
    assert.equal(plan.holder, addr(10))
    assert.equal(plan.rawUsds, FIXED_Q_RAW.toString())
    assert.equal(plan.seed.physicalSha256, sha(sources.seedBytes))
    assert.equal(
      plan.checkpoint.implementationCodeHash,
      sources.checkpoint.checkpoint.contract.implementationCodeHash,
    )
    savePlan({ plan, sources, out: x.planOut, stat })
    assert.equal(verify({ out: x.planOut, sourceOptions: x.sourceOptions }).status, 'selected')
    assert.equal(readPlan({ out: x.planOut, sourceOptions: x.sourceOptions }).sha256, plan.sha256)
    assert.throws(() => savePlan({ plan, sources, out: x.planOut, stat }))
  } finally {
    x.cleanup()
  }
})

test('no-eligible result is sealed without changing q', () => {
  const x = fixture(true)
  try {
    const sources = readSources(x.sourceOptions)
    const plan = makePlan({ sources, createdUtc: x.createdUtc })
    assert.equal(plan.status, 'no_eligible')
    assert.equal(plan.holder, null)
    assert.equal(plan.rawUsds, FIXED_Q_RAW.toString())
  } finally {
    x.cleanup()
  }
})

test('late seed, earlier outcome checkpoint, and changed source seal are rejected', () => {
  const x = fixture()
  try {
    const sources = readSources(x.sourceOptions)
    assert.throws(() =>
      makePlan({ sources, createdUtc: new Date(sources.seed.captureEndMs - 1).toISOString() }),
    )
    const future = {
      ...sources.checkpoint,
      checkpoint: {
        ...sources.checkpoint.checkpoint,
        block: { ...sources.checkpoint.checkpoint.block, number: 101 },
        captureEndUtc: new Date(Date.parse(x.createdUtc) - 1).toISOString(),
      },
    }
    assert.throws(() =>
      makePlan({
        sources: { ...sources, checkpoints: [...sources.checkpoints, future] },
        createdUtc: x.createdUtc,
      }),
    )
    const plan = makePlan({ sources, createdUtc: x.createdUtc })
    assert.throws(() => validatePlan({ ...plan, rawUsds: '1' }, { sources }))
    assert.throws(() =>
      makePlan({ sources: { ...sources, seedBytes: Buffer.from('{}') }, createdUtc: x.createdUtc }),
    )
  } finally {
    x.cleanup()
  }
})

test('a second seed blocks creation and replay even with an explicit chosen filename', () => {
  const x = fixture()
  try {
    const sources = readSources(x.sourceOptions)
    const plan = makePlan({ sources, createdUtc: x.createdUtc })
    savePlan({ plan, sources, out: x.planOut, stat })
    const chosen = readdirSync(x.sourceOptions.seedOut).find((name) => name.endsWith('.json'))
    copyFileSync(join(x.sourceOptions.seedOut, chosen), join(x.sourceOptions.seedOut, 'other.json'))
    assert.throws(() => readSources({ ...x.sourceOptions, seedFilename: chosen }))
    assert.throws(() => readPlan({ out: x.planOut, sourceOptions: x.sourceOptions }))
  } finally {
    x.cleanup()
  }
})
