import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { decodeFunctionData, encodeFunctionResult, keccak256, parseAbi } from 'viem'
import { sourceIdentity, IMPLEMENTATION_SLOT } from './susds-finalized-checkpoint.mjs'
import { FIXED_Q_RAW } from './susds-holder-seed.mjs'
import { makePlan, readSources as readPlanSources, savePlan } from './susds-holder-plan.mjs'
import {
  classifyWithdrawFailure,
  makeIssue,
  observe,
  readSources,
  validateIssue,
  verify,
} from './susds-fixed-holder-exit.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const seal = (value) => ({ ...value, sha256: sha(JSON.stringify(value)) })
const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`
const source = sourceIdentity([
  {
    name: 'sUSDS',
    enabled: true,
    address: '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd',
    underlying: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
    decimals: 18,
  },
])
const holder = addr(10)
const implementation = addr(999)
const vaultCode = '0x60016002'
const implCode = '0x60036004'
const slot = `0x${'0'.repeat(24)}${implementation.slice(2)}`
const stat = () => ({ bavail: 2_000_000_000, bsize: 1 })
const abi = parseAbi([
  'function asset() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'susds-fixed-exit-'))
  const checkpointOut = join(root, 'checkpoints')
  const seedOut = join(root, 'seeds')
  const planOut = join(root, 'plan')
  const out = join(root, 'exits')
  mkdirSync(checkpointOut)
  mkdirSync(seedOut)
  const now = Date.now()
  const block = (number, age) => ({
    number,
    hash: `0x${number.toString(16).padStart(64, 'a')}`,
    timestamp: Math.floor((now - age) / 1000),
  })
  const anchor = block(100, 240_000)
  const later = block(101, 60_000)
  const checkpoint = (b, age) =>
    seal({
      study: 'susds-finalized-vault-checkpoint-v1',
      source,
      captureStartUtc: new Date(now - age + 10_000).toISOString(),
      captureEndUtc: new Date(now - age + 11_000).toISOString(),
      block: b,
      pinMode: 'hash',
      pinCaveat: null,
      contract: {
        vaultCodeHash: keccak256(vaultCode),
        implementationSlotWord: slot,
        implementation,
        implementationCodeHash: keccak256(implCode),
      },
      state: {
        asset: source.asset,
        decimals: 18,
        totalAssetsRaw: '100',
        totalSupplyRaw: '100',
        assetsPerShareRaw: '100',
      },
      caveat:
        'One finalized-block source and state observation; code hashes do not establish historical implementation parity or holder exit feasibility.',
    })
  const writeCheckpoint = (row) => {
    const filename = `${String(row.block.number).padStart(12, '0')}-${row.block.hash.slice(2)}.json`
    const bytes = `${JSON.stringify(row)}\n`
    writeFileSync(join(checkpointOut, filename), bytes)
    return {
      filename,
      logicalSha256: row.sha256,
      physicalSha256: sha(bytes),
      block: row.block,
      vaultCodeHash: row.contract.vaultCodeHash,
      implementation,
      implementationCodeHash: row.contract.implementationCodeHash,
    }
  }
  const anchorRow = checkpoint(anchor, 240_000)
  const anchorRef = writeCheckpoint(anchorRow)
  const rawBody = JSON.stringify({
    items: Array.from({ length: 50 }, (_, i) => ({
      address: { hash: addr(i + 10) },
      value: String(50 - i),
    })),
    next_page_params: { items_count: 50, value: '1' },
  })
  const raw = JSON.parse(rawBody)
  const rows = raw.items.map((item, i) => ({
    listedRank: i + 1,
    address: item.address.hash,
    listedSharesRaw: item.value,
  }))
  const results = rows.map((row) => ({
    ...row,
    code: '0x',
    codeHash: null,
    balanceSharesRaw: String(50n * FIXED_Q_RAW - BigInt(row.listedRank)),
    maxWithdrawAssetsRaw: FIXED_Q_RAW.toString(),
    previewSharesRaw: FIXED_Q_RAW.toString(),
    readError: null,
    status: 'eligible',
  }))
  const seed = seal({
    study: 'susds-holder-seed-v1',
    kind: 'blockscout-first-page',
    source,
    checkpoint: anchorRef,
    anchor,
    page: {
      url: `https://eth.blockscout.com/api/v2/tokens/${source.vault}/holders`,
      httpStatus: 200,
      fetchedAtMs: now - 208_000,
      nextPageParamsPresent: true,
      rawItems: raw.items,
      rawNextPageParams: raw.next_page_params,
      rawBody,
      rawBodySha256: sha(rawBody),
      rows,
    },
    captureStartMs: now - 210_000,
    captureEndMs: now - 200_000,
    vaultCodeHash: anchorRow.contract.vaultCodeHash,
    asset: source.asset,
    results,
    status: 'sampled',
    candidates: rows.map((row) => row.address),
    caveat:
      'Blockscout first-page discovery sample, not a holder census, key control, withdrawal intent, or executable outcome. Listed order and values are untrusted offchain metadata; eligibility uses one finalized Ethereum block and one RPC host.',
  })
  const seedFilename = `${String(anchor.number).padStart(12, '0')}-${anchor.hash.slice(2)}-${seed.captureEndMs}.json`
  writeFileSync(join(seedOut, seedFilename), `${JSON.stringify(seed)}\n`)
  const sourceOptions = { seedOut, checkpointOut, identity: source }
  const planSources = readPlanSources(sourceOptions)
  const plan = makePlan({ sources: planSources, createdUtc: new Date(now - 190_000).toISOString() })
  savePlan({ plan, sources: planSources, out: planOut, stat })
  const laterRow = checkpoint(later, 60_000)
  writeCheckpoint(laterRow)
  const options = { out, planOut, checkpointOut, seedOut, identity: source }
  const sources = readSources(options)
  return {
    root,
    options,
    sources,
    later,
    laterRow,
    addCheckpoint: (number, age) => {
      const row = checkpoint(block(number, age), age)
      writeCheckpoint(row)
      return row
    },
    plan,
    now,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function result(status = 'success') {
  return {
    status,
    sharesBurnedRaw: status === 'success' ? '100' : null,
    balanceSharesRaw: '200',
    maxWithdrawAssetsRaw: '300',
    previewSharesRaw: '100',
  }
}

test('issue binds sealed plan, newer checkpoint, physical sources and independent diagnostics', () => {
  const x = fixture()
  try {
    const row = x.sources.checkpoints.at(-1)
    const issue = makeIssue({
      sources: x.sources,
      checkpointRow: row,
      result: result(),
      captureStartUtc: new Date(x.now - 40_000).toISOString(),
      captureEndUtc: new Date(x.now - 39_000).toISOString(),
    })
    assert.equal(issue.holder, holder)
    assert.equal(issue.codeRelation, 'same_as_plan_anchor')
    assert.equal(issue.rawUsds, FIXED_Q_RAW.toString())
    assert.equal(issue.plan.physicalSha256, sha(readFileSync(join(x.options.planOut, 'plan.json'))))
    assert.equal(validateIssue(issue, { sources: x.sources }), issue)
    assert.throws(() =>
      validateIssue(seal({ ...issue, rawUsds: '1', sha256: undefined }), { sources: x.sources }),
    )
    assert.throws(() =>
      validateIssue(
        seal({
          ...issue,
          plan: { ...issue.plan, physicalSha256: '0'.repeat(64) },
          sha256: undefined,
        }),
        { sources: x.sources },
      ),
    )
    assert.throws(() =>
      makeIssue({
        sources: x.sources,
        checkpointRow: x.sources.checkpoints[0],
        result: result(),
        captureStartUtc: new Date(x.now - 40_000).toISOString(),
        captureEndUtc: new Date(x.now - 39_000).toISOString(),
      }),
    )
    assert.throws(() =>
      makeIssue({
        sources: x.sources,
        checkpointRow: row,
        result: result(),
        captureStartUtc: x.plan.createdUtc,
        captureEndUtc: x.plan.createdUtc,
      }),
    )
  } finally {
    x.cleanup()
  }
})

test('structured EVM revert is distinct from provider ambiguity', () => {
  assert.equal(classifyWithdrawFailure({ code: 3, data: '0x08c379a0' }), 'revert')
  assert.equal(classifyWithdrawFailure({ cause: { code: 3, data: '0x' } }), 'revert')
  assert.equal(
    classifyWithdrawFailure({ code: -32000, message: 'execution reverted' }),
    'provider_ambiguous',
  )
  assert.equal(classifyWithdrawFailure({ code: 429 }), 'provider_ambiguous')
})

function clientFor(x, withdraw = 'success', code = vaultCode) {
  const calls = []
  const request = async ({ method, params }) => {
    calls.push({ method, params })
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getBlockByNumber')
      return {
        number: `0x${x.later.number.toString(16)}`,
        hash: x.later.hash,
        timestamp: `0x${x.later.timestamp.toString(16)}`,
      }
    if (method === 'eth_getCode')
      return params[0] === source.vault ? code : params[0] === implementation ? implCode : '0x'
    if (method === 'eth_getStorageAt') {
      assert.equal(params[1], IMPLEMENTATION_SLOT)
      return slot
    }
    if (method === 'eth_call') {
      const decoded = decodeFunctionData({ abi, data: params[0].data })
      if (decoded.functionName === 'withdraw') {
        assert.equal(params[0].from.toLowerCase(), holder)
        assert.deepEqual(
          decoded.args.map(String).map((v) => v.toLowerCase()),
          [FIXED_Q_RAW.toString(), holder, holder],
        )
        if (withdraw === 'revert') throw { code: 3, data: '0x08c379a0' }
        if (withdraw === 'provider') throw { code: 429 }
      }
      const value = decoded.functionName === 'asset' ? source.asset : 100n
      return encodeFunctionResult({ abi, functionName: decoded.functionName, result: value })
    }
    throw new Error(`Unexpected method ${method}`)
  }
  return { client: { request }, calls }
}

test('observes exact later finalized block, replay is idempotent, offline verifier detects tamper', async () => {
  const x = fixture()
  try {
    const mock = clientFor(x)
    const now = () => new Date(x.now - 30_000)
    const first = await observe({ client: mock.client, ...x.options, now, stat })
    assert.equal(first.status, 'success')
    assert.equal(first.block, x.later.number)
    assert.equal(verify(x.options).count, 1)
    assert.equal(
      (await observe({ client: mock.client, ...x.options, now, stat })).reason,
      'no_eligible_unobserved_checkpoint',
    )
    const issue = JSON.parse(readFileSync(first.path, 'utf8'))
    assert.equal(issue.result.sharesBurnedRaw, '100')
    assert.equal(
      mock.calls
        .filter((row) => row.method === 'eth_call')
        .every((row) => row.params[1].blockHash === x.later.hash),
      true,
    )
    writeFileSync(first.path, `${JSON.stringify({ ...issue, rawUsds: '1' })}\n`)
    assert.throws(() => verify(x.options))
  } finally {
    x.cleanup()
  }
})

test('revert is recorded; provider error is ambiguous; changed code prevents issue', async () => {
  for (const scenario of ['revert', 'provider', 'code']) {
    const x = fixture()
    try {
      const mock = clientFor(x, scenario, scenario === 'code' ? '0x60016003' : vaultCode)
      const now = () => new Date(x.now - 30_000)
      if (scenario === 'code') {
        await assert.rejects(() => observe({ client: mock.client, ...x.options, now, stat }))
        assert.equal(verify(x.options).count, 0)
      } else {
        const observed = await observe({ client: mock.client, ...x.options, now, stat })
        assert.equal(observed.status, scenario === 'revert' ? 'revert' : 'provider_ambiguous')
        assert.equal(verify(x.options).count, 1)
      }
    } finally {
      x.cleanup()
    }
  }
})

test('multiple post-plan checkpoints are observed oldest first and verified in order', async () => {
  const x = fixture()
  try {
    const third = x.addCheckpoint(102, 40_000)
    const now = () => new Date(x.now - 20_000)
    const first = await observe({ client: clientFor(x).client, ...x.options, now, stat })
    assert.equal(first.block, 101)
    const second = await observe({
      client: clientFor({ ...x, later: third.block }).client,
      ...x.options,
      now,
      stat,
    })
    assert.equal(second.block, 102)
    assert.equal(verify(x.options).count, 2)
  } finally {
    x.cleanup()
  }
})

test('a sealed later issue cannot skip an earlier eligible checkpoint', () => {
  const x = fixture()
  try {
    const third = x.addCheckpoint(102, 40_000)
    const sources = readSources(x.options)
    const row = sources.checkpoints.find(
      (item) => item.checkpoint.block.number === third.block.number,
    )
    const issue = makeIssue({
      sources,
      checkpointRow: row,
      result: result(),
      captureStartUtc: new Date(x.now - 20_000).toISOString(),
      captureEndUtc: new Date(x.now - 19_000).toISOString(),
    })
    const dir = join(x.options.out, 'issues')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(
        dir,
        `${String(third.block.number).padStart(12, '0')}-${third.block.hash.slice(2)}.json`,
      ),
      `${JSON.stringify(issue)}\n`,
    )
    assert.throws(() => verify(x.options), /skips an earlier eligible checkpoint/)
  } finally {
    x.cleanup()
  }
})

test('a stale oldest unobserved checkpoint blocks a fresher later one', async () => {
  const x = fixture()
  try {
    x.addCheckpoint(102, 40_000)
    const future = () => new Date(x.now + 3_550_000)
    const observed = await observe({ client: clientFor(x).client, ...x.options, now: future, stat })
    assert.deepEqual(observed, {
      status: 'unavailable',
      reason: 'oldest_unobserved_checkpoint_stale',
      block: 101,
    })
    assert.equal(verify(x.options).count, 0)
  } finally {
    x.cleanup()
  }
})
